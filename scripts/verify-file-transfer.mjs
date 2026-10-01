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
const client = new Client({ name: 'command-bridge-file-verifier', version: '1.0.0' });
// Print only known categories, never arbitrary messages, paths or response data.
function failureCategory(result) {
  const error = result.structuredContent?.error;
  const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
  const reason = typeof error?.message === 'string' ? error.message.match(/^(?:Windows transfer ACL check failed|Could not lock the transfer directory|File operation failed) \((owner|readable|writable|query|startup|load|open|EACCES|EPERM|EIO|ENOENT|EBUSY|ENOSPC|unknown)\)/)?.[1] : undefined;
  return code + (reason ? `:${reason}` : '');
}
const timer = setTimeout(() => { console.error('File verification timed out.'); process.exit(1); }, 30000);
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers }, fetch: serviceFetch }));
  const { randomUUID, createHash } = await import('node:crypto');
  const path = 'verify-' + randomUUID() + '.bin';
  const data = Buffer.from([0, 255, 128, 42]);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const upload = await client.callTool({ name: 'command_bridge_upload_file', arguments: { path, contentBase64: data.toString('base64'), sha256 } });
  if (upload.isError || !upload.structuredContent?.ok) {
    throw new Error(`Upload verification failed (${failureCategory(upload)}).`);
  }
  const download = await client.callTool({ name: 'command_bridge_download_file', arguments: { path } });
  if (download.isError || download.structuredContent?.sha256 !== sha256 || download.structuredContent?.contentBase64 !== data.toString('base64')) {
    throw new Error(`Download verification failed (${failureCategory(download)}).`);
  }
  const audit = await client.callTool({ name: 'command_bridge_list_audit_events', arguments: { limit: 100 } });
  for (const id of [upload.structuredContent.auditId, download.structuredContent.auditId]) {
    const events = (audit.structuredContent?.events ?? []).filter(e => e.auditId === id);
    if (events.length !== 2 || !events.some(e => e.phase === 'attempted') || !events.some(e => e.phase === 'completed' && e.fileTransfer?.sha256 === sha256)) throw new Error('File Audit lifecycle missing.');
  }
  console.log('Service file upload/download and Audit verification passed.');
} finally { clearTimeout(timer); await client.close(); }
