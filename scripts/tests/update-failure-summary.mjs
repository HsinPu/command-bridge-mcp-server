import { readFileSync } from 'node:fs';

// CI-only summary of the administrator-private worker log. All output is fixed
// vocabulary, counts or numeric source locations; never return matched text.
export function summarizeUpdateFailure(log, platform) {
  const windows = platform === 'win32';
  const installer = readFileSync(new URL(windows ? '../windows/install.ps1' : '../linux-systemd/install.sh', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL(windows ? '../bootstrap.ps1' : '../bootstrap.sh', import.meta.url), 'utf8');
  const indices = (source, expression) => [...source.matchAll(expression)].flatMap((match, index) => {
    const prefix = match[1].split('$')[0];
    return prefix.length > 12 && log.includes(prefix) ? [index + 1] : [];
  });
  const locations = [];
  if (windows) {
    for (const [role, pattern] of [
      ['installer', /[\\/]scripts[\\/]windows[\\/]install\.ps1:(\d+)\s+char:(\d+)/g],
      ['bootstrap', /[\\/]bootstrap\.ps1:(\d+)\s+char:(\d+)/g]
    ]) {
      for (const match of log.matchAll(pattern)) {
        const line = Number(match[1]), column = Number(match[2]);
        if (line > 0 && line <= 65535 && column > 0 && column <= 65535) locations.push({ role, line, column });
        if (locations.length >= 16) break;
      }
    }
  }
  return {
    installerErrorIndices: indices(installer, windows ? /throw ["']([^"'\n]+)/g : /fail "([^"\n]+)/g),
    bootstrapErrorIndices: indices(bootstrap, windows ? /throw ["']([^"'\n]+)/g : /echo '([^']+)'/g),
    locations: locations.slice(0, 16),
    stages: [
      ['runtime-download', 'Downloading Node.js'], ['wrapper-download', 'Downloading WinSW'],
      ['source-tests', 'Installing locked dependencies'], ['service-verified', 'Installation complete. Service']
    ].flatMap(([stage, marker]) => log.includes(marker) ? [stage] : []),
    curlExitCodes: [...log.matchAll(/curl: \((\d{1,3})\)/g)].slice(0, 16).map(match => Number(match[1])),
    failedTestIndices: [...log.matchAll(/not ok (\d{1,4})/g)].slice(0, 64).map(match => Number(match[1])),
    specFailureCount: Math.min(256, [...log.matchAll(/^\s*✖ /gm)].length),
    knownErrorCategories: ['EACCES', 'ENOENT', 'EEXIST', 'ERR_ASSERTION', 'ECONNREFUSED', 'EPERM', 'ETIMEDOUT', 'ENOTFOUND', 'COMMAND_OUTPUT_ENCODING_INVALID', 'AUDIT_LOG_WRITE_FAILED', 'FILE_ROOT_UNSAFE', 'UnauthorizedAccessException', 'ParserError', 'WebException', 'RemoteCertificateChainErrors', 'TLS'].filter(code => log.includes(code))
  };
}
