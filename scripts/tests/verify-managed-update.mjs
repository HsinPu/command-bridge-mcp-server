import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
let host = config.COMMAND_BRIDGE_HTTP_HOST;
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':')) host = `[${host}]`;
const base = `http://${host}:${config.COMMAND_BRIDGE_HTTP_PORT}`;
const headers = { Authorization: `Bearer ${config.COMMAND_BRIDGE_BEARER_TOKEN}` };
const allowedHost = config.COMMAND_BRIDGE_ALLOWED_HOSTS?.split(',')[0]?.trim();
if (allowedHost) headers.Host = allowedHost;
// Node fetch may replace Host. Preserve the configured virtual host while connecting locally.
async function serviceFetch(input, init) {
  const outgoing = new Request(input, init);
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
  return await new Promise((resolve, reject) => {
    const connection = request(outgoing.url, { method: outgoing.method, headers: Object.fromEntries(outgoing.headers), signal: outgoing.signal }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) connection.destroy(new Error('Verification response too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    connection.on('error', reject);
    connection.end(body);
  });
}

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const targetSha = process.argv[3];
if (!/^[a-f0-9]{40}$/.test(targetSha)) throw Error('Expected fixture SHA required');
async function call(name, args = {}) {
  const client = new Client({ name: 'managed-update-verifier', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers }, fetch: serviceFetch }));
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); }
}
async function terminal(id) {
  for (let i=0; i<600; i++) {
    try {
      const result = await call('command_bridge_get_update_status', { jobId: id });
      if (!result.isError && ['succeeded','failed','interrupted'].includes(result.structuredContent.state)) return result.structuredContent;
    } catch {}
    await sleep(1000);
  }
  throw Error('Managed task did not finish within the verification budget');
}
async function idle() {
  for (let i=0; i<30; i++) {
    const r = process.platform === 'win32'
      ? spawnSync(process.env.SystemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile','-NonInteractive','-Command', "(Get-ScheduledTask -TaskName CommandBridgeUpdate).State.ToString()"], { encoding:'utf8', timeout:15000 })
      : spawnSync('/usr/bin/systemctl', ['show','command-bridge-update.service','--property=ActiveState','--value'], { encoding:'utf8', timeout:5000 });
    if (r.status === 0 && !/^(Running|active|activating|deactivating)$/m.test(r.stdout.trim())) return;
    await sleep(1000);
  }
  throw Error('Managed worker remains active after terminal record');
}
const timer = setTimeout(() => { console.error('Managed update verification timed out'); process.exit(1); }, 15 * 60_000);
try {
  const beforeConfig = readFileSync(process.argv[2]);
  const accepted = await call('command_bridge_update');
  if (accepted.isError || accepted.structuredContent.state !== 'accepted') throw Error('Managed request was not accepted');
  const first = accepted.structuredContent;
  const duplicate = await call('command_bridge_update');
  if (duplicate.isError || duplicate.structuredContent.jobId !== first.jobId) throw Error('Concurrent request created another job');
  const done = await terminal(first.jobId);
  if (done.state !== 'succeeded' || done.after.sourceSha !== targetSha || done.before.sourceSha === done.after.sourceSha) throw Error('Update did not activate the candidate SHA');
  await idle();
  const hostname = await call('command_bridge_run_command', {command:'hostname'});
  if (hostname.isError || !hostname.structuredContent.ok || hostname.structuredContent.exitCode !== 0) throw Error('Updated service failed real command execution');
  if (!beforeConfig.equals(readFileSync(process.argv[2]))) throw Error('Update changed configuration or Token');
  const events = await call('command_bridge_list_audit_events', { limit:100 });
  if (events.isError || !events.structuredContent.events.some(e => e.phase === 'completed' && e.command.includes(first.jobId))) throw Error('Accepted update Audit not queryable');
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Disposable runner required for injected failure');
  const bootstrap = process.platform === 'win32' ? process.env.ProgramFiles + '/CommandBridgeMCP/bootstrap.ps1' : '/opt/command-bridge/current/bootstrap.sh';
  const originalBootstrap = readFileSync(bootstrap);
  try {
    writeFileSync(bootstrap, process.platform === 'win32' ? 'exit 17\r\n' : '#!/bin/bash\nexit 17\n');
    const failedRequest = await call('command_bridge_update');
    if (failedRequest.isError) throw Error('Failure fixture was not accepted');
    const failedJob = await terminal(failedRequest.structuredContent.jobId);
    if (failedJob.state !== 'failed' || failedJob.before.sourceSha !== targetSha || failedJob.after.sourceSha !== targetSha) throw Error('Failed update did not preserve deployment');
    await idle();
    const stillRunning = await call('command_bridge_run_command', {command:'hostname'});
    if (stillRunning.isError || !stillRunning.structuredContent.ok) throw Error('Failed update damaged the running service');
  } finally { writeFileSync(bootstrap, originalBootstrap); }
  const previousLatest = await call('command_bridge_get_update_status');
  // The service still has its startup setting. The privileged backend must
  // independently honor a saved disable setting, without a service restart.
  const text = beforeConfig.toString('utf8');
  const disabled = /^COMMAND_BRIDGE_MCP_UPDATE_ENABLED=/m.test(text) ? text.replace(/^COMMAND_BRIDGE_MCP_UPDATE_ENABLED=.*$/m,'COMMAND_BRIDGE_MCP_UPDATE_ENABLED=false') : text + '\nCOMMAND_BRIDGE_MCP_UPDATE_ENABLED=false\n';
  try {
    writeFileSync(process.argv[2], disabled);
    const rejected = await call('command_bridge_update');
    if (!rejected.isError) throw Error('Saved disable setting was ignored');
    const latest = await call('command_bridge_get_update_status');
    if (latest.isError || latest.structuredContent.jobId !== previousLatest.structuredContent.jobId) throw Error('Disabled request created a new job');
    await idle();
  } finally { writeFileSync(process.argv[2], beforeConfig); }
  console.log('Managed MCP update activated a different SHA, survived service restart, retained configuration/Audit, and enforced saved disable.');
} finally { clearTimeout(timer); }
