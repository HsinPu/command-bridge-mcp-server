// Test-only bounded startup wait. Callers must still run verify-install.mjs.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
const config = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
let host = config.COMMAND_BRIDGE_HTTP_HOST;
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
const deadline = Date.now() + 20_000;
while (true) {
  const connected = await new Promise(resolve => {
    const socket = createConnection({ host, port: Number(config.COMMAND_BRIDGE_HTTP_PORT) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(Math.min(1000, Math.max(1, deadline - Date.now())), () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
  if (connected) break;
  if (Date.now() >= deadline) throw new Error('Service listener did not start within 20 seconds.');
  await new Promise(resolve => setTimeout(resolve, 100));
}
