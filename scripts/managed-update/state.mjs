// Privileged, installer-owned fixed-purpose controller. No user command input.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = '/var/lib/command-bridge-update';
const unit = 'command-bridge-update.service';
const app = '/usr/local/lib/command-bridge/current';
export function updateEnabled(text) {
  const lines = text.split(/\r?\n/).filter(line => /^\s*COMMAND_BRIDGE_MCP_UPDATE_ENABLED\s*=/.test(line));
  if (!lines.length) return true;
  if (lines.length !== 1) throw Error('Invalid update setting');
  const value = lines[0].split('=').slice(1).join('=').trim().match(/^(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*(?:#.*)?$/);
  const parsed = value && (value[1] ?? value[2] ?? value[3]);
  if (!['true', 'false'].includes(parsed)) throw Error('Invalid update setting');
  return parsed === 'true';
}
export function safeInfo(info) {
  if (!/^\d+\.\d+\.\d+$/.test(info.version) || !/^[a-f0-9]{40}$/.test(info.sourceSha)) throw Error('Invalid installation identity');
  return { version: info.version, sourceSha: info.sourceSha };
}
function installed() { return safeInfo(JSON.parse(fs.readFileSync(join(app, 'install-info.json'), 'utf8'))); }
function record(job) {
  const audit = join(root, 'audit.jsonl');
  if (fs.existsSync(audit) && fs.statSync(audit).size > 10 * 1024 * 1024) {
    if (fs.existsSync(audit + '.4')) fs.unlinkSync(audit + '.4');
    for (let i = 3; i >= 1; i--) if (fs.existsSync(audit + '.' + i)) fs.renameSync(audit + '.' + i, audit + '.' + (i + 1));
    fs.renameSync(audit, audit + '.1');
  }
  fs.appendFileSync(audit, JSON.stringify({ event: 'command_bridge.update', ...job }) + '\n', { mode: 0o640 });
  for (const file of [job.jobId + '.json', 'latest.json']) {
    const temp = join(root, '.' + randomUUID());
    fs.writeFileSync(temp, JSON.stringify(job) + '\n', { mode: 0o640, flag: 'wx' });
    fs.renameSync(temp, join(root, file));
  }
}
function latest() { return JSON.parse(fs.readFileSync(join(root, 'latest.json'), 'utf8')); }
function active() {
  const r = spawnSync('/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) throw Error('Update service unavailable');
  return ['active', 'activating', 'deactivating'].includes(r.stdout.trim());
}
function enabled() {
  if (!updateEnabled(fs.readFileSync('/etc/command-bridge/command-bridge.env', 'utf8'))) throw Error('Managed update disabled');
}
function identity() {
  const match = fs.readFileSync('/etc/systemd/system/command-bridge.service', 'utf8').match(/^User=(command-bridge|\d+)$/m);
  if (!match) throw Error('Unmanaged service identity');
  const r = spawnSync('/usr/bin/getent', ['passwd', match[1]], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw Error('Missing service account');
  const [name, , uid, gid] = r.stdout.trim().split(':');
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid) || uid === '0') throw Error('Unsafe service identity');
  return { name, uid, gid, installer: match[1] !== 'command-bridge' };
}
export async function main(action) {
  if (process.getuid?.() !== 0) throw Error('Administrator required');
  if (!['request', 'run', 'finish'].includes(action) || process.argv.length !== 3) throw Error('Fixed update operation required');
  process.umask(0o027);
  const dir = fs.lstatSync(root);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o022)) throw Error('Unsafe update state directory');
  if (action === 'finish') {
    const job = latest();
    if (['accepted', 'running'].includes(job.state)) record({ ...job, state: 'interrupted', errorCode: 'UPDATE_INTERRUPTED', finishedAt: new Date().toISOString() });
    return;
  }
  enabled();
  const account = identity();
  if (action === 'request') {
    if (process.env.SUDO_UID !== account.uid) throw Error('Unexpected requester account');
    if (active()) { console.log(JSON.stringify(latest())); return; }
    try { const old = latest(); if (['accepted', 'running'].includes(old.state)) record({ ...old, state: 'interrupted', errorCode: 'UPDATE_INTERRUPTED', finishedAt: new Date().toISOString() }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const job = { schemaVersion: 1, jobId: randomUUID(), state: 'accepted', startedAt: new Date().toISOString(), finishedAt: null, before: installed(), after: null, errorCode: null };
    record(job);
    const start = spawnSync('/usr/bin/systemctl', ['start', '--no-block', unit], { stdio: 'ignore', timeout: 5000 });
    if (start.status !== 0) {
      record({ ...job, state: 'failed', finishedAt: new Date().toISOString(), errorCode: 'UPDATE_START_FAILED' });
      throw Error('Update service start failed');
    }
    console.log(JSON.stringify(job));
    return;
  }
  const job = latest();
  if (job.state !== 'accepted') throw Error('No accepted request');
  // Allow the acceptance/Audit response to leave MCP before restarting it.
  await sleep(10_000);
  enabled();
  record({ ...job, state: 'running' });
  const work = fs.mkdtempSync(join(root, 'work-'));
  fs.chmodSync(work, 0o700);
  const log = fs.openSync(join(work, 'install.log'), 'wx', 0o600);
  try {
    const bootstrap = join(work, 'bootstrap.sh');
    fs.copyFileSync(join(app, 'bootstrap.sh'), bootstrap);
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' };
    // Root selects the existing, managed account; no caller-supplied identity.
    if (account.installer) Object.assign(env, { SUDO_USER: account.name, SUDO_UID: account.uid, SUDO_GID: account.gid });
    const code = await new Promise(resolve => {
      const child = spawn('/bin/bash', [bootstrap, '--update'], { env, stdio: ['ignore', log, log] });
      child.once('error', () => resolve(-1)); child.once('close', code => resolve(code));
    });
    record({ ...job, state: code === 0 ? 'succeeded' : 'failed', finishedAt: new Date().toISOString(), after: installed(), errorCode: code === 0 ? null : 'UPDATE_INSTALL_FAILED' });
    const old = fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort((a,b) => fs.statSync(join(root,b)).mtimeMs - fs.statSync(join(root,a)).mtimeMs);
    for (const name of old.slice(20)) fs.unlinkSync(join(root, name));
  } finally {
    fs.closeSync(log);
    const diagnosticRoot = join(root, 'diagnostics');
    fs.mkdirSync(diagnosticRoot, { recursive: true, mode: 0o700 });
    const data = fs.readFileSync(join(work, 'install.log'));
    fs.writeFileSync(join(diagnosticRoot, job.jobId + '.log'), data.subarray(Math.max(0, data.length - 1024 * 1024)), { mode: 0o600 });
    const logs = fs.readdirSync(diagnosticRoot).filter(name => /^[a-f0-9-]{36}\.log$/.test(name)).sort((a,b) => fs.statSync(join(diagnosticRoot,b)).mtimeMs - fs.statSync(join(diagnosticRoot,a)).mtimeMs);
    for (const name of logs.slice(20)) fs.unlinkSync(join(diagnosticRoot,name));
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => { console.error('Managed update control failed; inspect administrator logs and task status.'); process.exitCode = 1; });
}
