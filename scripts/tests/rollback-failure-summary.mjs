import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeUpdateFailure } from './update-failure-summary.mjs';

// CI-only: public diagnostics consist of fixed categories and bounded counts.
// The underlying installer log remains private, including on summary failure.
export function summarizeRollbackFailure(log, platform) {
  const summary = summarizeUpdateFailure(log, platform);
  summary.installerErrorIndices = summary.installerErrorIndices.slice(0, 64);
  summary.bootstrapErrorIndices = summary.bootstrapErrorIndices.slice(0, 64);
  return {
    ...summary,
    designatedFaultSeen: log.includes('INJECTED_POST_ACTIVATION_FAILURE'),
    networkMismatchSeen: log.includes('Network refresh did not take effect'),
    verificationTimeoutSeen: log.includes('MCP installation verification timed out.'),
    readinessFailureSeen: log.includes('Service dependencies are not ready.')
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, platform] = process.argv.slice(2);
    if (!path || !['win32', 'linux'].includes(platform) || statSync(path).size > 4 * 1024 * 1024) throw 0;
    const bytes = readFileSync(path);
    // Windows PowerShell 5.1 redirection writes UTF-16LE with a BOM.
    const log = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    console.log('Rollback failure summary:', JSON.stringify(summarizeRollbackFailure(log, platform)));
  } catch {
    console.log('Rollback failure summary:', JSON.stringify({ summaryUnavailable: true }));
    process.exitCode = 1;
  }
}
