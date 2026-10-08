import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile, readFile, symlink, link, chmod, rename, unlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileTransferService, lockWindowsRoot } from "./fileTransferService.js";
import { serializeAuditEvent, parseWindowsEventLogLines, type AuditLog, type CommandAuditEvent } from "./auditLog.js";
import type { AppConfig } from "../config/env.js";
import { loadConfig } from "../config/env.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpTransport } from "../transport/httpTransport.js";
import { CommandExecutor } from "./commandExecutor.js";
class MemoryAudit implements AuditLog {
  events: CommandAuditEvent[] = [];
  failure: "attempted" | "completed" | undefined;
  async write(event: CommandAuditEvent) { if (event.phase === this.failure) throw new Error("Audit unavailable"); this.events.push(event); }
  async list() { return { events: this.events, hasMore: false }; }
}
const config = (root: string): AppConfig => ({ transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: "unrestricted", allowedShells: ["sh"], allowedCommands: new Set(), allowedRoots: ["/"], defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [], fileTransfer: { root, upload: true, download: true, maxBytes: 1024 } });
const payload = (data: Buffer, path = "sample.bin") => ({ path, contentBase64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") });

test("file transfer configuration is opt-in and rejects missing roots and excessive limits", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    process.env.COMMAND_BRIDGE_EXECUTION_MODE = "unrestricted";
    assert.equal(loadConfig().fileTransfer!.upload, false);
    assert.equal(loadConfig().fileTransfer!.download, false);
    process.env.COMMAND_BRIDGE_UPLOAD_ENABLED = "true";
    assert.throws(loadConfig, /absolute/);
    process.env.COMMAND_BRIDGE_TRANSFER_ROOT = "relative";
    assert.throws(loadConfig, /absolute/);
    process.env.COMMAND_BRIDGE_TRANSFER_ROOT = tmpdir();
    assert.equal(loadConfig().fileTransfer!.download, false);
    process.env.COMMAND_BRIDGE_TRANSFER_MAX_BYTES = "5242881";
    assert.throws(loadConfig, /configuration/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("file transfer permissions remain independent in unrestricted mode and rejected attempts are audited", async () => {
  const cfg = config("/absent"), audit = new MemoryAudit();
  cfg.fileTransfer!.upload = false; cfg.fileTransfer!.download = false;
  const files = new FileTransferService(cfg, audit);
  await assert.rejects(files.upload(payload(Buffer.from("private"))), /disabled/);
  await assert.rejects(files.download("sample.bin"), /disabled/);
  assert.deepEqual(audit.events.map(e => e.phase), ["attempted", "blocked", "attempted", "blocked"]);
  assert.equal(JSON.stringify(audit.events).includes("private"), false);
  const malformed = { ...audit.events[0], fileTransfer: { ...audit.events[0].fileTransfer, operation: ["upload"], contentBase64: "private" } };
  assert.deepEqual(parseWindowsEventLogLines(JSON.stringify(malformed)), []);
  audit.failure = "attempted";
  await assert.rejects(files.upload(payload(Buffer.from("data"))), /Audit unavailable/);
});

test("Linux transfers round-trip binary data, preserve lifecycle metadata and never overwrite", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-")), audit = new MemoryAudit(), files = new FileTransferService(config(root), audit);
  try {
    const data = Buffer.from([0, 255, 1, 128]), request = payload(data);
    const uploaded = await files.upload(request), downloaded = await files.download(request.path);
    assert.equal(uploaded.sha256, downloaded.sha256); assert.equal(downloaded.contentBase64, request.contentBase64);
    assert.deepEqual(audit.events.map(e => e.phase), ["attempted", "completed", "attempted", "completed"]);
    const normalized = parseWindowsEventLogLines(audit.events.map(serializeAuditEvent).join("\n"));
    assert.equal(normalized.find(e => e.phase === "completed")!.fileTransfer!.sha256, request.sha256);
    await assert.rejects(files.upload(request), /already exists/);
    await assert.rejects(files.upload({ ...request, overwrite: true, expectedSha256: request.sha256 }), /not supported/);
    assert.deepEqual(await readdir(root), [request.path]);
    await writeFile(join(root, ".upload-orphan"), "partial");
    await assert.rejects(files.download(request.path), /cleanup is required/);
    await rm(join(root, ".upload-orphan"));
    for (const path of ["../escape", "/etc/passwd", "sub/file", "sub\\file", "CON.txt", "a:b", ".env", "policy.json", "trailing."]) await assert.rejects(files.download(path), /filename/);
    for (const contentBase64 of ["!!!!", "Zg=", "Zh=="]) await assert.rejects(files.upload({ ...request, path: "other.bin", contentBase64 }));
    await assert.rejects(files.upload(payload(Buffer.alloc(1025), "large.bin")), /limit/);
    await assert.rejects(files.upload({ ...payload(Buffer.from("x"), "bad.bin"), sha256: "0".repeat(64) }), /SHA/);
    await symlink("/etc/passwd", join(root, "escape.txt"));
    await assert.rejects(files.download("escape.txt"), /regular files/);
    await link(join(root, request.path), join(root, "linked.bin"));
    await assert.rejects(files.download("linked.bin"), /regular files/);
    await writeFile(join(root, "large.bin"), Buffer.alloc(1025));
    await assert.rejects(files.download("large.bin"), /limit/);
    await chmod(root, 0o755); await assert.rejects(files.download("large.bin"), /private/); await chmod(root, 0o700);
  } finally { await files.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("Windows transfers refuse ordinary user-owned or unverified roots", { skip: process.platform !== "win32" }, async () => {
  // Hosted Windows TEMP can use RUNNER~1; reach ACL validation with its
  // canonical path rather than testing the earlier alias rejection instead.
  const root = await realpath(await mkdtemp(join(tmpdir(), "cb-files-acl-"))), audit = new MemoryAudit();
  try {
    const files = new FileTransferService(config(root), audit);
    await assert.rejects(files.upload(payload(Buffer.from("data"))), /ACL check failed \((owner|readable|writable)\)/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows directory lease permits exclusive file publication and prevents directory replacement", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-lock-"));
  let lease;
  try {
    lease = await lockWindowsRoot(root);
    const bytes = Buffer.from("\uFEFF中文檔案🙂\r\n完整第二行\r\n");
    await writeFile(join(root, "temporary.bin"), bytes);
    await link(join(root, "temporary.bin"), join(root, "published.bin"));
    await unlink(join(root, "temporary.bin"));
    assert.deepEqual(await readFile(join(root, "published.bin")), bytes);
    await assert.rejects(rename(root, root + "-moved"));
    assert.deepEqual(await readdir(root), ["published.bin"]);
    await lease.release(); lease = undefined;
    await rename(root, root + "-moved");
  } finally { await lease?.release(); await rm(root, { recursive: true, force: true }); await rm(root + "-moved", { recursive: true, force: true }); }
});

test("Windows directory lease reports a failed native open and cleans its control temporary directory", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-missing-"));
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("cb-root-lease-")));
  try {
    await assert.rejects(lockWindowsRoot(join(root, "absent")), error => {
      assert.match((error as Error).message, /transfer directory \(open\)/);
      return true;
    });
    const remaining = (await readdir(tmpdir())).filter(name => name.startsWith("cb-root-lease-") && !before.has(name));
    assert.deepEqual(remaining, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux transfer cancellation and terminal Audit failure withhold content and report committed uploads", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-failure-")), audit = new MemoryAudit(), files = new FileTransferService(config(root), audit);
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(files.upload(payload(Buffer.from("x")), controller.signal), /cancelled/);
    assert.deepEqual(await readdir(root), []);
    audit.failure = "completed";
    await assert.rejects(files.upload(payload(Buffer.from("content"))), /committed.*Audit/);
    assert.deepEqual(await readdir(root), ["sample.bin"]);
    await assert.rejects(files.download("sample.bin"), /withheld/);
    audit.failure = undefined;
    assert.equal((await files.download("sample.bin")).size, 7);
    await files.shutdown(); await assert.rejects(files.download("sample.bin"), /cancelled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux transfer keeps its slot until terminal Audit finishes and then releases it", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-busy-"));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  class SlowAudit extends MemoryAudit {
    async write(event: CommandAuditEvent) {
      if (event.phase === "completed" && event.fileTransfer?.operation === "upload") { started(); await gate; }
      await super.write(event);
    }
  }
  const audit = new SlowAudit(), files = new FileTransferService(config(root), audit);
  const pending = files.upload(payload(Buffer.from("data")));
  try {
    await reached;
    await assert.rejects(files.download("sample.bin"), /already active/);
    release(); await pending;
    assert.equal((await files.download("sample.bin")).size, 4);
    assert.equal(audit.events.filter(e => e.phase === "blocked" && e.errorCode === "FILE_TRANSFER_BUSY").length, 1);
  } finally { release(); await pending.catch(() => undefined); await files.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("Linux HTTP MCP file transfer authenticates before parsing large bodies and returns matching Audit", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-files-http-")), audit = new MemoryAudit(), cfg = config(root);
  cfg.transport = "http"; cfg.bearerToken = "test-token-".repeat(4); cfg.httpPort = 0; cfg.fileTransfer!.maxBytes = 300000;
  const executor = new CommandExecutor(cfg, audit), server = await startHttpTransport(cfg, executor);
  const client = new Client({ name: "file-transfer-test", version: "1.0.0" });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const denied = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
    assert.equal(denied.status, 401);
    const headers = { Authorization: `Bearer ${cfg.bearerToken}` };
    const large = await fetch(base + "/mcp", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(410000) }) });
    assert.equal(large.status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
    const data = Buffer.alloc(200000, 123), request = payload(data);
    const uploaded = await client.callTool({ name: "command_bridge_upload_file", arguments: request });
    assert.equal(uploaded.isError, false);
    const downloaded = await client.callTool({ name: "command_bridge_download_file", arguments: { path: request.path } });
    assert.equal((downloaded.structuredContent as Record<string, unknown>).contentBase64, request.contentBase64);
    const events = await client.callTool({ name: "command_bridge_list_audit_events", arguments: {} });
    assert.equal(((events.structuredContent as Record<string, unknown>).events as CommandAuditEvent[]).filter(e => e.fileTransfer?.sha256 === request.sha256).length, 2);
    for (const [name, bytes] of [
      ["utf8.txt", Buffer.from("中文完整文件🙂\r\n第二行\r\n")],
      ["bom.txt", Buffer.concat([Buffer.from([239,187,191]), Buffer.from("中文 BOM\n")])],
      ["utf16.txt", Buffer.concat([Buffer.from([255,254]), Buffer.from("中文🙂\r\n", "utf16le")])],
      ["big5.txt", Buffer.from("a4a4a4e50d0a", "hex")]
    ] as const) {
      const upload = payload(bytes, name);
      assert.equal((await client.callTool({ name: "command_bridge_upload_file", arguments: upload })).isError, false);
      const download = await client.callTool({ name: "command_bridge_download_file", arguments: { path: name } });
      assert.equal(download.isError, false);
      const body = download.structuredContent as any;
      assert.equal(body.sha256, upload.sha256); assert.deepEqual(Buffer.from(body.contentBase64, "base64"), bytes);
    }
  } finally { await client.close(); await executor.shutdown(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
