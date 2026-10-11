import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const discover = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? discover(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []);
// Every installation builds and tests on the target host. Serialize test files
// on both platforms so CPU-count defaults do not compete with host workloads.
// Individual tests retain their original deadlines and security assertions.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...discover('dist')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
