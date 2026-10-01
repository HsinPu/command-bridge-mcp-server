import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync('dist/version.js', `export const version = ${JSON.stringify(version)};\n`);
if (process.platform === 'win32') {
  // Compile fixed native interop once during deployment, never inside a request.
  const script = resolve('scripts/windows/build-directory-lease.ps1');
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const native = spawnSync(compiler, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputPath', resolve('dist/windows-directory-lease.dll')], { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
  if (native.status !== 0) process.exit(native.status ?? 1);
}
