import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const discover = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? discover(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []);
const result = spawnSync(process.execPath, ['--test', ...discover('dist')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
