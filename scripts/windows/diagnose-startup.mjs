// Failure-only CI diagnostic. Never dump environment values, payloads or output.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { buildChildEnvironment } from '../../dist/services/commandExecutor.js';
if (process.platform !== 'win32') throw new Error('Windows diagnostic only');
const directory = mkdtempSync(join(tmpdir(), 'command-bridge-startup-'));
const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const probe = join(directory, 'probe.ps1');
const wrapper = resolve('scripts/windows/run-cmdlet.ps1');
try {
  writeFileSync(probe, `param([string]$Wrapper)
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('CB_STAGE_ENGINE_READY')
try {
  & $Wrapper
  [Console]::Error.WriteLine('CB_STAGE_WRAPPER_COMPLETE')
} catch {
  [Console]::Error.WriteLine('CB_STAGE_WRAPPER_ERROR')
  exit 1
}
`);
  console.log(JSON.stringify({ node: process.version, windows: release(), architecture: process.arch }));
  for (const [name, environment] of [['filtered', buildChildEnvironment([])], ['parent-reference', { ...process.env }]]) {
    environment.PSModulePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules');
    environment.COMMAND_BRIDGE_CMDLET_REQUEST = Buffer.from(JSON.stringify({ name: 'Microsoft.PowerShell.Utility\\Get-Date', args: [] })).toString('base64');
    const started = Date.now();
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, wrapper], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    console.log(JSON.stringify({ probe: name, elapsedMs: Date.now() - started, exitCode: result.status, errorCode: result.error?.code ?? null, stages: result.stderr?.match(/CB_STAGE_[A-Z_]+/g) ?? [] }));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
