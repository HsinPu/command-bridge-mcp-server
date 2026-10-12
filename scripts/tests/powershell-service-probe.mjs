// Instrument only a disposable source copy; never alter the published entry.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
const [root, sha] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows' || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Disposable Windows probe required');
const temporary = realpathSync(process.env.RUNNER_TEMP);
const actual = realpathSync(root);
if (!relative(temporary, actual) || relative(temporary, actual).startsWith('..') || resolve(actual) === resolve(temporary)) throw Error('Probe source must be private');
const path = join(actual, 'src/services/commandExecutor.ts');
let source = readFileSync(path, 'utf8');
source = "import { readFileSync as readProbeInfo } from 'node:fs';\n" + source;
const env = '        environment.COMMAND_BRIDGE_POWERSHELL_REQUEST = command;';
if (!source.includes(env)) throw Error('Probe environment boundary missing');
source = source.replace(env, env + `\n        try { if (JSON.parse(readProbeInfo(fileURLToPath(new URL('../../install-info.json', import.meta.url)), 'utf8')).sourceSha === '${sha}') environment.COMMAND_BRIDGE_PS_STAGE = join(process.env.ProgramData ?? 'C:\\\\ProgramData', 'CommandBridgeMCP/work/ps-startup-stage.txt'); } catch {}`);
const mark = n => `if ($env:COMMAND_BRIDGE_PS_STAGE) { [IO.File]::WriteAllText($env:COMMAND_BRIDGE_PS_STAGE,'${n}') }; `;
const changes = [
  ['"[Console]::OutputEncoding =', '"' + mark(1) + '[Console]::OutputEncoding ='],
  ['"[Console]::InputEncoding =', '"' + mark(2) + '[Console]::InputEncoding ='],
  ['"$commandBridgeSource =', '"' + mark(3) + '$commandBridgeSource ='],
  ['"Import-Module -Name', '"' + mark(4) + 'Import-Module -Name'],
  ['-ErrorAction Stop }; "', '-ErrorAction Stop }; ' + mark(5) + '"'],
  ['". ([scriptblock]::Create($commandBridgeSource))"', '"' + mark(6) + '. ([scriptblock]::Create($commandBridgeSource)); ' + mark(7) + '"']
];
for (const [before, after] of changes) { if (!source.includes(before)) throw Error('Probe phase boundary missing'); source = source.replace(before, after); }
writeFileSync(path, source);
writeFileSync(join(actual, '.command-bridge-source-sha'), sha + '\n');
