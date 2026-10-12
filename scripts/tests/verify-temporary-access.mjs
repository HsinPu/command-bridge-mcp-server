// Real managed-service verification, only called on disposable CI hosts.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== (process.platform === 'win32' ? 'Windows' : 'Linux')) throw Error('Disposable CI host required');
const windows = process.platform === 'win32';
const root = windows ? join(process.env.ProgramFiles, 'CommandBridgeMCP') : '/usr/local/lib/command-bridge';
const metadata = JSON.parse(readFileSync(join(root, windows ? 'install-info.json' : 'current/install-info.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^[a-f0-9]{40}$/.test(metadata.sourceSha)) throw Error('ACCESS_SMOKE_METADATA');
const release = realpathSync(join(root, `releases/v${metadata.version}-${metadata.sourceSha}`));
const runtime = windows ? join(root, 'runtime/node.exe') : join(root, 'runtime/current/bin/node');
const config = windows ? join(process.env.ProgramData, 'CommandBridgeMCP/command-bridge.env') : '/etc/command-bridge/command-bridge.env';
const before = readFileSync(config);
const { parseSavedConfiguration } = await import(pathToFileURL(join(release, 'dist/cli/connectionSetup.js')).href);
const { readAccessStatus } = await import(pathToFileURL(join(release, 'dist/cli/access.js')).href);
const values = parseSavedConfiguration(before);
const cli = (operation, minutes) => {
  const args = ['access', operation, ...(minutes ? ['--minutes', String(minutes)] : [])];
  const call = windows ? spawnSync(runtime, [join(release, 'dist/cli/access.js'), ...args], { encoding: 'utf8', timeout: 20000 }) :
    spawnSync('/usr/local/bin/command-bridge', args, { encoding: 'utf8', timeout: 20000 });
  if (call.status !== 0) {
    const code = (call.stderr ?? '').match(/CommandBridge access: (ACCESS_[A-Z_]+|ADMINISTRATOR_REQUIRED|TOKEN_INVALID|SERVICE_INSTALLATION_REQUIRED|INSTALLATION_UNSAFE)\b/)?.[1] ?? 'UNKNOWN';
    throw Error(`ACCESS_SMOKE_CLI_${operation.toUpperCase()} code=${code} exit=${call.status ?? -1}`);
  }
};
const probe = (command = 'hostname', expectation, stage = 'baseline') => {
  const call = spawnSync(runtime, [join(release, 'scripts/verify-install.mjs'), config, command, ...(expectation ? [expectation] : [])], { encoding: 'utf8', timeout: 30000 });
  if (call.status !== 0) {
    const summary = (call.stderr ?? '').match(/VERIFIER_COMMAND_FAILURE code=[A-Z_]{1,64} error=[01] ok=[01] exit=(?:unknown|-?\d{1,10}) timeout=[01] truncated=[01]/)?.[0];
    if (summary) console.error(summary);
    const failures = ['Service dependencies are not ready.', 'Matching audit lifecycle was not returned.', 'Independent diagnostics verification failed.', 'Installed fixed diagnostic reader verification failed.', 'Verification command returned unexpected output.', 'Expected command rejection was not returned.'];
    const kind = failures.findIndex(message => (call.stderr ?? '').includes(message));
    throw Error(`ACCESS_SMOKE_MCP_AUDIT stage=${stage} kind=${kind} exit=${call.status ?? -1}`);
  }
};
const status = () => readAccessStatus(values);
const original = await status();
if (original.baseMode === 'unrestricted') throw Error('ACCESS_SMOKE_RESTRICTED_BASE_REQUIRED');
cli('open', 1);
if ((await status()).effectiveMode !== 'unrestricted') throw Error('ACCESS_SMOKE_OPEN');
probe('echo CB_TEMP_ACCESS', 'CB_TEMP_ACCESS', 'temporary');
probe('command-bridge access open', 'error:LOCAL_ADMIN_COMMAND_BLOCKED', 'local-admin-block');
cli('close');
if ((await status()).effectiveMode !== original.baseMode) throw Error('ACCESS_SMOKE_CLOSE');
cli('open', 1);
const expires = (await status()).expiresAt;
await new Promise(resolve => setTimeout(resolve, Math.max(1, expires - Date.now() + 500)));
if ((await status()).effectiveMode !== original.baseMode) throw Error('ACCESS_SMOKE_EXPIRY');
probe('hostname', undefined, 'expiry');
cli('open', 1);
const restart = windows ? spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Restart-Service CommandBridgeMCP'], { timeout: 20000, stdio: 'ignore' }) :
  spawnSync('/usr/bin/systemctl', ['restart', 'command-bridge.service'], { timeout: 20000, stdio: 'ignore' });
if (restart.status !== 0) throw Error('ACCESS_SMOKE_RESTART');
let restarted;
const deadline = Date.now() + 20000;
while (!restarted) {
  try { restarted = await status(); } catch { if (Date.now() >= deadline) throw Error('ACCESS_SMOKE_RESTART_STATUS'); await new Promise(r => setTimeout(r, 200)); }
}
if (restarted.instanceId === original.instanceId || restarted.effectiveMode !== original.baseMode || restarted.grantId !== null) throw Error('ACCESS_SMOKE_RESTART_RESTORE');
cli('status'); cli('close'); probe('hostname', undefined, 'restart');
if (!readFileSync(config).equals(before)) throw Error('ACCESS_SMOKE_CONFIGURATION_CHANGED');
console.log('Temporary access: real admin CLI, MCP/Audit, expiry, restart restoration and configuration preservation passed.');
