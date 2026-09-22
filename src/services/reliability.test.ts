import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { FileAuditLog } from "./fileAuditLog.js";
import { createAuditEvent, runFixedProcess, type AuditLog, type CommandAuditEvent } from "./auditLog.js";
import { CommandExecutor, terminateProcessTree } from "./commandExecutor.js";
import type { AppConfig } from "../config/env.js";
import { startHttpTransport } from "../transport/httpTransport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadCommandProfiles } from "./commandProfiles.js";

const config = (): AppConfig => ({ transport: "http", bearerToken: "test-token-".repeat(4), httpHost: "127.0.0.1", httpPort: 0, allowedHosts: ["127.0.0.1"], executionMode: "unrestricted", allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(), allowedRoots: [process.cwd()], defaultTimeoutMs: 1000, maxTimeoutMs: 3000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] });
class MemoryAudit implements AuditLog {
  events: CommandAuditEvent[] = [];
  async write(event: CommandAuditEvent) { this.events.push(event); }
  async list(limit: number) { return { events: this.events.slice(-limit).reverse(), hasMore: false }; }
}
test("a stalled audit helper fails within its deadline", async () => {
  const started = Date.now();
  await assert.rejects(runFixedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"]), /timed out/);
  assert.ok(Date.now() - started < 8000);
});

test("Windows reports termination tool failure", { skip: process.platform !== "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = join(tmpdir(), "nonexistent-command-bridge-system");
    await assert.rejects(terminateProcessTree(child));
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill(); await closed;
  }
});
test("installer verifies real MCP and audit through the configured virtual host", async () => {
  const cfg = config(); cfg.allowedHosts = ["bridge.internal"];
  const executor = new CommandExecutor(cfg, new MemoryAudit());
  const server = await startHttpTransport(cfg, executor);
  const directory = await mkdtemp(join(tmpdir(), "command-bridge-verifier-"));
  try {
    const path = join(directory, "service.env");
    await writeFile(path, `COMMAND_BRIDGE_HTTP_HOST=127.0.0.1\nCOMMAND_BRIDGE_HTTP_PORT=${(server.address() as { port: number }).port}\nCOMMAND_BRIDGE_ALLOWED_HOSTS=bridge.internal\nCOMMAND_BRIDGE_BEARER_TOKEN=${cfg.bearerToken}\n`);
    const result = await promisify(execFile)(process.execPath, [join(process.cwd(), "scripts/verify-install.mjs"), path], { timeout: 20_000 });
    assert.match(result.stdout, /verification passed/);
  } finally {
    await executor.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("file audit rotates five files, redacts secrets and reads newest events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "command-bridge-audit-test-"));
  try {
    const audit = new FileAuditLog(directory, 500);
    for (let i = 0; i < 8; i++) await audit.write(createAuditEvent({ auditId: String(i), command: "echo --password secret", phase: "completed", executionMode: "allowlist", source: "stdio" }));
    assert.equal((await readdir(directory)).length, 5);
    const result = await audit.list(2);
    assert.deepEqual(result.events.map(e => e.auditId), ["7", "6"]);
    assert.equal(result.hasMore, true);
    assert.ok(!JSON.stringify(result).includes("secret"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("HTTP authenticates readiness and completes actual MCP execution and audit", async () => {
  const cfg = config(); const audit = new MemoryAudit();
  const executor = new CommandExecutor(cfg, audit);
  const server = await startHttpTransport(cfg, executor);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: "integration-test", version: "1" });
  try {
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal((await fetch(base + "/ready")).status, 401);
    const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
      get(base + "/ready", { headers: { Authorization: `Bearer ${cfg.bearerToken}`, Host: "untrusted.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(rejectedHost, 403);
    assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
    assert.equal((await fetch(base + "/ready", { headers: { Authorization: `Bearer ${cfg.bearerToken}` } })).status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${cfg.bearerToken}` } } }));
    const result = await client.callTool({ name: "command_bridge_run_command", arguments: { command: "hostname" } });
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { ok: boolean }).ok, true);
    assert.equal(audit.events.filter(e => e.phase === "attempted").length, 1);
    await executor.shutdown();
    assert.equal((await fetch(base + "/ready", { headers: { Authorization: `Bearer ${cfg.bearerToken}` } })).status, 503);
    await assert.rejects(executor.execute({ command: "hostname" }), /stopping/);
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("readiness fails closed when audit storage is unavailable", async () => {
  const audit: AuditLog = { async write() { throw new Error("private storage path"); }, async list() { throw new Error("unavailable"); } };
  const result = await new CommandExecutor(config(), audit).readiness();
  assert.equal(result.ready, false);
  assert.equal(result.checks.audit, false);
  assert.ok(!JSON.stringify(result).includes("private storage"));
});
test("Linux timeout forcibly stops a process ignoring SIGTERM", { skip: process.platform !== "linux" }, async () => {
  const executor = new CommandExecutor(config(), new MemoryAudit());
  const started = Date.now();
  const result = await executor.execute({ command: "trap '' TERM; while :; do sleep 1; done" });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 7000);
});

test("safe execution launches native programs and fixed PowerShell wrappers", async () => {
  const cfg = config();
  cfg.executionMode = "allowlist";
  cfg.defaultTimeoutMs = cfg.maxTimeoutMs = 15_000;
  cfg.allowedShells = [process.platform === "win32" ? "powershell" : "bash"];
  cfg.allowedCommands = new Set(process.platform === "win32" ? ["hostname", "get-date"] : ["hostname"]);
  cfg.commandProfiles = loadCommandProfiles();
  const executor = new CommandExecutor(cfg, new MemoryAudit());
  try {
    for (const command of process.platform === "win32" ? ["hostname", "Get-Date"] : ["hostname"]) {
      const result = await executor.execute({ command, timeoutMs: 15_000 });
      const detail = JSON.stringify({ command, ...result });
      assert.equal(result.ok, true, detail);
      assert.equal(result.exitCode, 0, detail);
      assert.equal(result.timedOut, false, detail);
      assert.equal(result.truncated, false, detail);
    }
    await assert.rejects(executor.execute({ command: 'hostname "-unexpected"' }), /Arguments/);
  } finally { await executor.shutdown(); }
});

test("cancellation is bounded and releases the concurrency slot", async () => {
  const cfg = config(); cfg.defaultTimeoutMs = 10_000;
  const audit = new MemoryAudit(); const executor = new CommandExecutor(cfg, audit);
  const controller = new AbortController();
  const operation = executor.execute({ command: process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30" }, controller.signal);
  const rejection = assert.rejects(operation, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(executor.execute({ command: "hostname" }), /parallel/);
  controller.abort();
  await rejection;
  assert.equal((await executor.execute({ command: "hostname" })).ok, true);
  assert.equal(audit.events.filter(e => e.errorCode === "COMMAND_CANCELLED").length, 1);
});

test("large output is capped and execution stops", async () => {
  const cfg = config(); cfg.maxOutputChars = 50;
  const executor = new CommandExecutor(cfg, new MemoryAudit());
  const result = await executor.execute({ command: process.platform === "win32" ? 'for /L %i in (1,1,100000) do @echo long-output-line' : 'while :; do echo long-output-line; done' });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length + result.stderr.length <= 50);
});
