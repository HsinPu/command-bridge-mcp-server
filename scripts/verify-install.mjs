import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config = Object.fromEntries(readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
let host = config.COMMAND_BRIDGE_HTTP_HOST;
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':')) host = `[${host}]`;
const base = `http://${host}:${config.COMMAND_BRIDGE_HTTP_PORT}`;
const headers = { Authorization: `Bearer ${config.COMMAND_BRIDGE_BEARER_TOKEN}` };
const allowedHost = config.COMMAND_BRIDGE_ALLOWED_HOSTS?.split(',')[0]?.trim();
if (allowedHost) headers.Host = allowedHost;
// Node fetch may replace Host. Preserve the configured virtual host while connecting locally.
async function serviceFetch(input, init) {
  const outgoing = new Request(input, init);
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
  return await new Promise((resolve, reject) => {
    const connection = request(outgoing.url, { method: outgoing.method, headers: Object.fromEntries(outgoing.headers), signal: outgoing.signal }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) connection.destroy(new Error('Verification response too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    connection.on('error', reject);
    connection.end(body);
  });
}
const ready = await serviceFetch(base + '/ready', { headers, signal: AbortSignal.timeout(15000) });
if (!ready.ok || !(await ready.json()).ready) throw new Error('Service dependencies are not ready.');
const client = new Client({ name: 'command-bridge-install-verifier', version: '1.0.0' });
const timer = setTimeout(() => { console.error('MCP installation verification timed out.'); process.exit(1); }, 30_000);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers }, fetch: serviceFetch }));
  const before = await client.callTool({ name: 'command_bridge_list_audit_events', arguments: { limit: 100 } });
  const previousIds = new Set((before.structuredContent?.events ?? []).map(event => event.auditId));
  const result = await client.callTool({ name: 'command_bridge_run_command', arguments: { command: 'hostname' } });
  if (result.isError || !result.structuredContent?.ok) throw new Error('Service account could not execute hostname.');
  let matched = false;
  for (let retry = 0; retry < 10 && !matched; retry++) {
    const after = await client.callTool({ name: 'command_bridge_list_audit_events', arguments: { limit: 100 } });
    const events = (after.structuredContent?.events ?? []).filter(event => !previousIds.has(event.auditId) && event.command === 'hostname');
    matched = events.some(event => event.phase === 'completed' && event.exitCode === 0 && events.some(attempt => attempt.auditId === event.auditId && attempt.phase === 'attempted'));
    if (!matched) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!matched) throw new Error('Matching audit lifecycle was not returned.');
  console.log('Service account MCP execution and audit verification passed.');
} finally { clearTimeout(timer); await client.close(); }
