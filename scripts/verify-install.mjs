import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { normalizeAllowedHosts } from '../dist/config/allowedHosts.js';
import { decodeUtf8File } from '../dist/services/textEncoding.js';
import { commandVerificationSummary } from '../dist/services/verificationSummary.js';
import { parseAuditTimeout, auditRequestTimeout } from '../dist/config/auditTimeout.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config = parse(decodeUtf8File(readFileSync(process.argv[2])));
const verificationCommand = process.argv[3] ?? 'hostname';
const expectedStdout = process.argv[4];
const expectedError = expectedStdout?.startsWith('error:') ? expectedStdout.slice(6) : undefined;
const auditMs = parseAuditTimeout(config.COMMAND_BRIDGE_AUDIT_TIMEOUT_MS);
const commandMs = Number(config.COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS ?? 15000);
const requestMs = auditRequestTimeout(auditMs, commandMs);
let host = config.COMMAND_BRIDGE_HTTP_HOST;
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':')) host = `[${host}]`;
const base = `http://${host}:${config.COMMAND_BRIDGE_HTTP_PORT}`;
const headers = { Authorization: `Bearer ${config.COMMAND_BRIDGE_BEARER_TOKEN}` };
const allowedHost = normalizeAllowedHosts(config.COMMAND_BRIDGE_ALLOWED_HOSTS)[0];
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
const readyDeadline = performance.now() + auditRequestTimeout(auditMs);
while (true) {
  const ready = await serviceFetch(base + '/ready', { headers, signal: AbortSignal.timeout(10000) });
  if (ready.ok && (await ready.json()).ready) break;
  if (performance.now() >= readyDeadline) throw new Error('Service dependencies are not ready.');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const client = new Client({ name: 'command-bridge-install-verifier', version: '1.0.0' });
const callTool = params => client.callTool(params, undefined, { timeout: requestMs });
const timer = setTimeout(() => { console.error('MCP installation verification timed out.'); process.exit(1); }, auditRequestTimeout(auditMs, commandMs, 4) + 30000);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers }, fetch: serviceFetch }));
  const before = await callTool({ name: 'command_bridge_list_audit_events', arguments: { limit: 100 } });
  const previousIds = new Set((before.structuredContent?.events ?? []).map(event => event.auditId));
  const result = await callTool({ name: 'command_bridge_run_command', arguments: { command: verificationCommand } });
  if (expectedError) {
    if (!result.isError || result.structuredContent?.error?.code !== expectedError) throw new Error('Expected command rejection was not returned.');
  } else {
    if (result.isError || !result.structuredContent?.ok) { console.error(commandVerificationSummary(result)); throw new Error('Service account could not execute the verification command.'); }
    if (expectedStdout !== undefined && result.structuredContent.stdout.trim() !== expectedStdout) throw new Error('Verification command returned unexpected output.');
  }
  let matched = false;
  for (let retry = 0; retry < 10 && !matched; retry++) {
    const after = await callTool({ name: 'command_bridge_list_audit_events', arguments: { limit: 100 } });
    const events = (after.structuredContent?.events ?? []).filter(event => !previousIds.has(event.auditId) && event.command === verificationCommand);
    matched = events.some(event => (expectedError ? event.phase === 'blocked' && event.errorCode === expectedError : event.phase === 'completed' && event.exitCode === 0) && events.some(attempt => attempt.auditId === event.auditId && attempt.phase === 'attempted'));
    if (!matched) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!matched) throw new Error('Matching audit lifecycle was not returned.');
  const diagnostics = await callTool({name:'command_bridge_get_diagnostics',arguments:{limit:20}});
  const summary = diagnostics.structuredContent;
  if(diagnostics.isError || !summary?.audit?.available || summary.mode!=='normal') throw new Error('Independent diagnostics verification failed.');
  const managed = process.platform==='win32' ? new URL(import.meta.url).pathname.toLowerCase().includes('/commandbridgemcp/') : new URL(import.meta.url).pathname.startsWith('/usr/local/lib/command-bridge/');
  const probe = summary.probes?.host;
  if(managed && (probe?.status!=='ok' || probe.data?.reader?.status!=='ok' || probe.data?.service?.state!=='running')) throw new Error('Installed fixed diagnostic reader verification failed.');
  console.log('Service account MCP execution and audit verification passed.');
} finally { clearTimeout(timer); await client.close(); }
