import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export function verifyLegacyJobsMigration(before, after) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(before);
  const values = parse(text);
  const keys = ['COMMAND_BRIDGE_JOBS_ENABLED', 'COMMAND_BRIDGE_JOBS_ROOT', 'COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS', 'COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS'];
  if (keys.some(key => values[key] !== undefined)) throw Error('LEGACY_JOBS_FIXTURE_INVALID');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const suffix = [
    'COMMAND_BRIDGE_JOBS_ENABLED=true',
    "COMMAND_BRIDGE_JOBS_ROOT='/var/lib/command-bridge-jobs'",
    'COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS=1800000',
    'COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS=3600000'
  ].join(newline) + newline;
  const expected = Buffer.concat([before, Buffer.from((text && !text.endsWith('\n') ? newline : '') + suffix)]);
  if (!expected.equals(after)) throw Error('LEGACY_JOBS_MIGRATION_MISMATCH');
}

let main = false;
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Imported helper. */ }
if (main) {
  try {
    if (process.argv.length !== 4) throw Error();
    verifyLegacyJobsMigration(readFileSync(process.argv[2]), readFileSync(process.argv[3]));
    console.log('Legacy configuration retained exactly with only the four expected job defaults appended.');
  } catch { console.error('LEGACY_JOBS_MIGRATION_VERIFICATION_FAILED'); process.exitCode = 1; }
}
