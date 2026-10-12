import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TemporaryAccess, parseAccessLease } from "./temporaryAccess.js";
import { parseAccessArgs } from "../cli/access.js";
import { assertNoLocalAdminCommand, assertNoSelfModification } from "./selfProtection.js";
import { CommandExecutor } from "./commandExecutor.js";
import type { AppConfig } from "../config/env.js";
import type { CommandAuditEvent } from "./auditLog.js";
import { startHttpTransport } from "../transport/httpTransport.js";
import { readAccessStatus } from "../cli/access.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

function fixture() {
  let wall = 1000000, mono = 0, record: string | null = null;
  const events: string[] = [];
  const control = new TemporaryAccess("guarded", async () => record, async a => { events.push(a); }, () => wall, () => mono);
  const lease = (milliseconds = 60000, action: "open" | "close" = "open") => ({ schemaVersion: 1, instanceId: control.instanceId, id: randomUUID(), action, issuedAt: wall, expiresAt: wall + (action === "open" ? milliseconds : 0) });
  return { control, events, lease, set: (v: unknown) => { record = typeof v === "string" ? v : JSON.stringify(v); }, tick: (w: number, m = w) => { wall += w; mono += m; } };
}
test("access arguments are bounded and no arbitrary mode, path or decimal is accepted", () => {
  assert.equal(parseAccessArgs(["access", "open"]).minutes, 5);
  assert.equal(parseAccessArgs(["access", "open", "--minutes", "60"]).minutes, 60);
  for (const args of [["access", "open", "--minutes", "0"], ["access", "open", "--minutes", "61"], ["access", "open", "--minutes", "1.5"], ["access", "status", "--minutes", "2"], ["access", "open", "--path", "other"]]) assert.throws(() => parseAccessArgs(args));
  assert.throws(() => parseAccessLease(JSON.stringify({ ...fixture().lease(), expiresAt: 5000000 })));
});
test("local access rejects DNS names disguised as loopback before sending credentials", async () => {
  await assert.rejects(readAccessStatus({ COMMAND_BRIDGE_HTTP_HOST: "127.attacker.invalid", COMMAND_BRIDGE_BEARER_TOKEN: "test-token-".repeat(4) }), { code: "ACCESS_LOCAL_LISTENER_REQUIRED" });
});
test("a local impostor cannot receive the Token or forge temporary-access status", async () => {
  const token = "private-token-".repeat(4);
  let authorization = "";
  const server = createServer((req, res) => { authorization = req.headers.authorization ?? ""; res.end(JSON.stringify({ schemaVersion: 1, instanceId: randomUUID(), baseMode: "guarded", effectiveMode: "guarded", grantId: null, expiresAt: null, remainingSeconds: 0 })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(readAccessStatus({ COMMAND_BRIDGE_HTTP_HOST: "127.0.0.1", COMMAND_BRIDGE_HTTP_PORT: String((server.address() as AddressInfo).port), COMMAND_BRIDGE_BEARER_TOKEN: token }), { code: "ACCESS_SERVICE_UNAVAILABLE" });
    assert.ok(authorization.startsWith("CommandBridge-HMAC ")); assert.ok(!authorization.includes(token));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test("leases expire monotonically, close immediately and cannot survive restart or replay", async () => {
  const f = fixture();
  try {
    const lease = f.lease(); f.set(lease); assert.equal(await f.control.refresh(), "unrestricted");
    f.tick(30000); await f.control.refresh(); assert.equal(f.control.status().remainingSeconds, 30);
    f.tick(0, 30001); assert.equal(f.control.mode(), "guarded"); assert.equal(await f.control.refresh(), "guarded");
    assert.ok(f.events.includes("expired"));
    const reopened = f.lease(); f.set(reopened); assert.equal(await f.control.refresh(), "unrestricted");
    f.set(f.lease(0, "close")); assert.equal(await f.control.refresh(), "guarded");
    f.set(reopened); assert.equal(await f.control.refresh(), "guarded");
    const restarted = new TemporaryAccess("guarded", async () => JSON.stringify(f.lease()), async () => {});
    assert.equal(await restarted.refresh(), "guarded"); await restarted.stop();
  } finally { await f.control.stop(); }
});
test("corruption, changed grant contents, backward clocks and failed Audit restore restrictions", async () => {
  const f = fixture();
  try {
    const a = f.lease(); f.set(a); await f.control.refresh(); f.set({ ...a, expiresAt: a.expiresAt + 1 }); assert.equal(await f.control.refresh(), "guarded");
    f.set(f.lease()); await f.control.refresh(); f.set("invalid"); assert.equal(await f.control.refresh(), "guarded");
    f.set(f.lease()); await f.control.refresh(); f.tick(-1, 1); assert.equal(f.control.mode(), "guarded");
    const denied: TemporaryAccess = new TemporaryAccess("allowlist", async () => JSON.stringify({ ...f.lease(), instanceId: denied.instanceId, issuedAt: Date.now(), expiresAt: Date.now() + 1000 }), async () => { throw Error("Audit unavailable"); });
    assert.equal(await denied.refresh(), "allowlist"); await denied.stop();
  } finally { await f.control.stop(); }
});
test("stuck storage reads coalesce and late completion cannot activate a timed-out grant", async () => {
  let release!: (s: string) => void, reads = 0;
  const wait = new Promise<string>(r => { release = r; });
  const control = new TemporaryAccess("guarded", () => { reads++; return wait; }, async () => {});
  const lease = JSON.stringify({ schemaVersion: 1, instanceId: control.instanceId, id: randomUUID(), action: "open", issuedAt: Date.now(), expiresAt: Date.now() + 60000 });
  const result = await Promise.all([control.refresh(), control.refresh()]); assert.deepEqual(result, ["guarded", "guarded"]); assert.equal(reads, 1);
  release(lease); await new Promise(r => setImmediate(r)); assert.equal(await control.refresh(), "guarded"); await control.stop();
});
test("an administrator close while opening Audit is pending cannot activate stale access", async () => {
  let record: string, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), opening = new Promise<void>(r => { entered = r; });
  const control = new TemporaryAccess("guarded", async () => record, async action => { if (action === "opened") { entered(); await gate; } });
  const now = Date.now(); record = JSON.stringify({ schemaVersion: 1, instanceId: control.instanceId, id: randomUUID(), action: "open", issuedAt: now, expiresAt: now + 60000 });
  const pending = control.refresh(); await opening;
  record = JSON.stringify({ schemaVersion: 1, instanceId: control.instanceId, id: randomUUID(), action: "close", issuedAt: now, expiresAt: now });
  release(); assert.equal(await pending, "guarded"); await control.stop();
});
test("MCP cannot directly invoke access administration or modify its protected lease", () => {
  for (const platform of ["linux", "win32"] as const) {
    for (const command of ["command-bridge access open --minutes 5", "sudo -n command-bridge access close", 'sh -c "command-bridge access status"']) assert.throws(() => assertNoLocalAdminCommand(command, platform, process.cwd()), { code: "LOCAL_ADMIN_COMMAND_BLOCKED" });
  }
  assert.throws(() => assertNoSelfModification("tee /etc/command-bridge/access-lease.json", "/tmp", { platform: "linux" }), { code: "SELF_MODIFICATION_BLOCKED" });
});
test("real HTTP status authenticates and temporary execution preserves command Audit and baseline", async () => {
  const events: CommandAuditEvent[] = [];
  const config: AppConfig = { transport: "http", bearerToken: "test-token-".repeat(4), httpHost: "127.0.0.1", httpPort: 0, allowedHosts: ["127.0.0.1"], executionMode: "allowlist",
    allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(["hostname"]), allowedRoots: [process.cwd()], defaultTimeoutMs: 15000, maxTimeoutMs: 15000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] };
  const executor = new CommandExecutor(config, { async write(e) { events.push(structuredClone(e)); }, async list() { return { events: [], hasMore: false }; } });
  let record: string | null = null;
  const control = new TemporaryAccess("allowlist", async () => record, a => executor.auditAccess(a)); executor.enableTemporaryAccess(control);
  const server = await startHttpTransport(config, executor);
  const values = { COMMAND_BRIDGE_HTTP_HOST: "127.0.0.1", COMMAND_BRIDGE_HTTP_PORT: String((server.address() as AddressInfo).port), COMMAND_BRIDGE_BEARER_TOKEN: config.bearerToken! };
  try {
    await assert.rejects(executor.execute({ command: "echo TEMP_ACCESS_TEST" }));
    const now = Date.now(); record = JSON.stringify({ schemaVersion: 1, instanceId: control.instanceId, id: randomUUID(), action: "open", issuedAt: now, expiresAt: now + 60000 });
    assert.equal((await readAccessStatus(values)).effectiveMode, "unrestricted");
    await assert.rejects(readAccessStatus({ ...values, COMMAND_BRIDGE_BEARER_TOKEN: "wrong-token-".repeat(4) }));
    const result = await executor.execute({ command: "echo TEMP_ACCESS_TEST" }); assert.equal(result.ok, true);
    const command = events.filter(e => e.command === "echo TEMP_ACCESS_TEST"); assert.deepEqual(command.slice(-2).map(e => [e.phase, e.executionMode]), [["attempted", "unrestricted"], ["completed", "unrestricted"]]);
    record = null; assert.equal((await readAccessStatus(values)).effectiveMode, "allowlist"); await assert.rejects(executor.execute({ command: "echo TEMP_ACCESS_TEST" }));
    assert.equal(config.executionMode, "allowlist");
  } finally { await executor.shutdown(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("Audit waiting cannot carry a grant past expiry into spawning a new command", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const events: CommandAuditEvent[] = [];
  const config: AppConfig = { transport: "stdio", httpHost: "127.0.0.1", httpPort: 0, allowedHosts: [], executionMode: "allowlist",
    allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(["hostname"]), allowedRoots: [process.cwd()], defaultTimeoutMs: 15000, maxTimeoutMs: 15000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] };
  const executor = new CommandExecutor(config, { async write(e) { events.push(structuredClone(e)); if (e.command === "echo EXPIRED_GRANT" && e.phase === "attempted") { entered(); await gate; } }, async list() { return { events: [], hasMore: false }; } });
  let wall = Date.now(), mono = 0;
  const control: TemporaryAccess = new TemporaryAccess("allowlist", async () => JSON.stringify({ schemaVersion: 1, instanceId: control.instanceId, id, action: "open", issuedAt: issued, expiresAt: issued + 60000 }), a => executor.auditAccess(a), () => wall, () => mono);
  const issued = wall, id = randomUUID(); executor.enableTemporaryAccess(control);
  try {
    const operation = executor.execute({ command: "echo EXPIRED_GRANT" });
    await started; wall += 60001; mono += 60001; release();
    await assert.rejects(operation, { code: "COMMAND_NOT_ALLOWED" });
    assert.equal(events.filter(e => e.command === "echo EXPIRED_GRANT").at(-1)?.executionMode, "allowlist");
  } finally { release(); await executor.shutdown(); }
});
