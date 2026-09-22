// Used only to mutate disposable test snapshots, never by production installers.
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function faultCode(sha, marker, host) {
  return `
import * as faultFs from 'node:fs';
const faultInfo = new URL('../install-info.json', import.meta.url);
if (faultFs.existsSync(faultInfo) && JSON.parse(faultFs.readFileSync(faultInfo, 'utf8')).sourceSha === ${JSON.stringify(sha)}) {
  if (config.COMMAND_BRIDGE_HTTP_HOST !== ${JSON.stringify(host)} || config.COMMAND_BRIDGE_ALLOWED_HOSTS !== ${JSON.stringify(host)}) throw new Error('Network refresh did not take effect');
  faultFs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ stage: 'verified', sha: ${JSON.stringify(sha)}, host: ${JSON.stringify(host)}, fault: 'INJECTED_POST_ACTIVATION_FAILURE' }), { flag: 'wx' });
  throw new Error('INJECTED_POST_ACTIVATION_FAILURE');
}
`;
}
export function assertEvidence(marker, sha, stage) {
  const evidence = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (evidence.sha !== sha || evidence.stage !== stage || evidence.fault !== (stage === 'verified' ? 'INJECTED_POST_ACTIVATION_FAILURE' : 'INJECTED_STARTUP_FAILURE')) throw new Error('Missing or incorrect activation evidence');
}
export function prepare(root, mode, sha, marker, host) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !['verify', 'health'].includes(mode)) throw new Error('Invalid fixture');
  if (fs.existsSync(marker)) throw new Error('Stale activation evidence');
  fs.writeFileSync(join(root, '.command-bridge-source-sha'), sha);
  if (mode === 'verify') {
    if (!['127.0.0.1', '127.0.0.2'].includes(host)) throw new Error('Loopback test host required');
    fs.appendFileSync(join(root, 'scripts/verify-install.mjs'), faultCode(sha, marker, host));
    for (const [name, anchor, replacement] of [
      ['scripts/linux-systemd/install.sh', '  parse_arguments "$@"', `  detect_private_ipv4() { printf '%s\\n' '${host}'; }\n  parse_arguments "$@"`],
      ['scripts/windows/install.ps1', '  Assert-Administrator', `  function Get-AutomaticHttpHost { return '${host}' }\n  Assert-Administrator`]
    ]) {
      const path = join(root, name); const text = fs.readFileSync(path, 'utf8');
      if (!text.includes(anchor)) throw new Error('Fixture anchor missing');
      fs.writeFileSync(path, text.replace(anchor, replacement));
    }
  } else {
    fs.writeFileSync(join(root, 'src/index.ts'), `import { writeFileSync, readFileSync } from 'node:fs';
const info = JSON.parse(readFileSync(new URL('../install-info.json', import.meta.url), 'utf8'));
if (info.sourceSha !== ${JSON.stringify(sha)}) throw new Error('Wrong test deployment');
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({stage:'started', sha:${JSON.stringify(sha)}, fault:'INJECTED_STARTUP_FAILURE'}));
console.error('INJECTED_STARTUP_FAILURE');
process.exit(1);
`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') prepare(...args);
  else if (command === 'assert') assertEvidence(...args);
  else throw new Error('Unknown fixture command');
}
