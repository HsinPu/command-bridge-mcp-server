// Failure-only CI diagnostic. Never dump environment values, payloads or output.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  // Isolate startup, module discovery, source transport and Unicode cwd with
  // private fixtures. Print only fixed stage metadata, never text or paths.
  const unicodeDirectory = join(directory, String.fromCodePoint(0x4e2d,0x6587,0x1f642));
  mkdirSync(unicodeDirectory);
  const file = join(unicodeDirectory, 'fixture.txt'), asciiFile = join(directory, 'fixture.txt');
  writeFileSync(file, String.fromCodePoint(0x4e2d,0x6587)); writeFileSync(asciiFile, 'fixture');
  const prefix = "[Console]::Error.WriteLine('CB_STAGE_ENGINE_READY'); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[Console]::OutputEncoding; $OutputEncoding=[Console]::OutputEncoding; [Console]::Error.WriteLine('CB_STAGE_PREFIX_READY'); ";
  const importer = "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop; [Console]::Error.WriteLine('CB_STAGE_MODULE_READY'); ";
  const read = "[Console]::Out.Write((Get-Content -LiteralPath $env:COMMAND_BRIDGE_TEST_TEXT_FILE -Raw -Encoding UTF8)); [Console]::Error.WriteLine('CB_STAGE_FILE_READ');";
  for (const [name, source, cwd, target, request] of [
    ['raw-unicode', read.replace('$env:COMMAND_BRIDGE_TEST_TEXT_FILE', "'"+file.replaceAll("'","''")+"'"), unicodeDirectory, file, null],
    ['pinned-discovery', read, unicodeDirectory, file, null],
    ['explicit-management', importer+read, unicodeDirectory, file, null],
    ['environment-source', importer+". ([scriptblock]::Create($env:COMMAND_BRIDGE_TEST_SOURCE))", unicodeDirectory, file, read],
    ['dotnet-read', "[Console]::Out.Write([IO.File]::ReadAllText($env:COMMAND_BRIDGE_TEST_TEXT_FILE,[Text.UTF8Encoding]::new($false,$true))); [Console]::Error.WriteLine('CB_STAGE_FILE_READ');", unicodeDirectory, file, null],
    ['ascii-reference', read, directory, asciiFile, null]
  ]) {
    const environment=buildChildEnvironment([]);
    environment.PSModulePath=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules');
    environment.COMMAND_BRIDGE_TEST_TEXT_FILE=target;
    if(request!==null) environment.COMMAND_BRIDGE_TEST_SOURCE=request;
    const started=Date.now(), result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',prefix+source],{cwd,env:environment,stdio:['ignore','pipe','pipe'],encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:64*1024});
    console.log(JSON.stringify({probe:name,elapsedMs:Date.now()-started,exitCode:result.status,errorCode:result.error?.code??null,stages:result.stderr?.match(/CB_STAGE_[A-Z_]+/g)??[]}));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
