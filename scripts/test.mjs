import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const discover = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? discover(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []);
// Windows tests launch PowerShell and compile native directory-lock helpers.
// Run test files sequentially to avoid competing cold compiler startups on CI;
// individual tests retain their original deadlines and security assertions.
const concurrency = process.platform === 'win32' ? ['--test-concurrency=1'] : [];
const result = spawnSync(process.execPath, ['--test', ...concurrency, ...discover('dist')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
