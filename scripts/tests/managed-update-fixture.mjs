// Only disposable CI mutates an installed bootstrap; production has no bypass.
import * as fs from 'node:fs';
import { posix, win32, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function fixtureBootstrap(original, platform, sha, version, archive) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+\.\d+\.\d+$/.test(version) || !(platform === 'win32' ? win32 : posix).isAbsolute(archive)) throw Error('Invalid disposable update fixture');
  const channel = 'https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt';
  if (platform === 'win32') {
    const anchor = `$channel = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 '${channel}').Content`;
    const download = '  Invoke-WebRequest -UseBasicParsing "https://github.com/HsinPu/command-bridge-mcp-server/archive/$($fields[0]).zip" -OutFile $archive';
    if (!original.includes(anchor) || !original.includes(download)) throw Error('Bootstrap fixture anchors missing');
    return original.replace(anchor, `$channel = "${sha}\`n${version}\`n"`).replace(download, `  Copy-Item -LiteralPath '${archive.replaceAll("'", "''")}' -Destination $archive`);
  }
  const anchor = `curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 -fsSL ${channel} -o "$work/channel.txt"`;
  const download = 'curl --proto \'=https\' --tlsv1.2 -fsSL "https://github.com/HsinPu/command-bridge-mcp-server/archive/${sha}.tar.gz" -o "$work/source.tar.gz"';
  if (!original.includes(anchor) || !original.includes(download)) throw Error('Bootstrap fixture anchors missing');
  const quote = "'" + archive.replaceAll("'", "'\\''") + "'";
  return original.replace(anchor, `printf '%s\\n' '${sha}' '${version}' > "$work/channel.txt"`).replace(download, `cp -- ${quote} "$work/source.tar.gz"`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Disposable GitHub runner required');
  const [platform, archive, version] = process.argv.slice(2);
  const bootstrap = platform === 'win32' ? join(process.env.ProgramFiles, 'CommandBridgeMCP', 'bootstrap.ps1') : '/opt/command-bridge/current/bootstrap.sh';
  fs.writeFileSync(bootstrap, fixtureBootstrap(fs.readFileSync(bootstrap, 'utf8'), platform, '4'.repeat(40), version, archive));
}
