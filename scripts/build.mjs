import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync('dist/version.js', `export const version = ${JSON.stringify(version)};\n`);
