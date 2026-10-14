import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config/env.js";
import { CommandExecutor } from "./commandExecutor.js";
import type { AuditLog, CommandAuditEvent } from "./auditLog.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpTransport } from "../transport/httpTransport.js";
import type { AddressInfo } from "node:net";

const windows = process.platform === "win32";
const exec = promisify(execFile);
class Audit implements AuditLog {
  events: CommandAuditEvent[] = [];
  failTerminal = false;
  async write(event: CommandAuditEvent) { if (this.failTerminal && event.phase !== "attempted") throw new Error("Injected terminal failure"); this.events.push(event); }
  async list() { return { events: this.events, hasMore: false }; }
}
async function fixture(overrides: Partial<AppConfig> = {}) {
  const root = await mkdtemp(join(windows ? process.env.ProgramData! : tmpdir(), "cb-jobs-"));
  if (windows) {
    const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetAccessRuleProtection($true,$false); $a.SetOwner($sid); foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r)}; [IO.Directory]::SetAccessControl($env:CB_JOB_TEST_ROOT,$a)";
    await exec(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, CB_JOB_TEST_ROOT: root }, timeout: 15000 });
  } else await chmod(root, 0o700);
  const config: AppConfig = { transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: "unrestricted", allowedShells: [windows ? "powershell" : "bash"], allowedCommands: new Set(["hostname"]), allowedRoots: [root], defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [], jobs: { enabled: true, root, defaultTimeoutMs: 15000, maxTimeoutMs: 3600000 }, ...overrides };
  const audit = new Audit(), executor = new CommandExecutor(config, audit);
  return { root, config, audit, executor, async close() { await executor.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const command = (code: string) => {
  const path = windows ? "& '" + process.execPath.replace(/'/g, "''") + "'" : "'" + process.execPath.replace(/'/g, "'\\''") + "'";
  return path + " -e 'eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())' " + Buffer.from(code).toString("base64");
};
async function finished(executor: CommandExecutor, id: string) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) { const job = await executor.jobs.get(id); if (!["queued", "starting", "running", "finalizing"].includes(job.state)) return job; await new Promise(r => setTimeout(r, 50)); }
  throw new Error("Private background job did not finish within its test budget.");
}

test("background acceptance survives request abort, uses independent timeout and deduplicates across restart", async () => {
  const f = await fixture();
  let restored: CommandExecutor | undefined;
  try {
    const requestId = randomUUID(), controller = new AbortController();
    const input = { requestId, command: command('setTimeout(()=>console.log("job-safe"),1500)'), timeoutMs: 20000 };
    const job = await f.executor.jobs.start(input, controller.signal);
    controller.abort();
    assert.equal((await f.executor.jobs.start(input)).jobId, job.jobId);
    await assert.rejects(f.executor.jobs.start({ ...input, command: "hostname" }), /different arguments/);
    const result = await finished(f.executor, job.jobId);
    assert.equal(result.state, "completed"); assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
    assert.equal((await f.executor.jobs.output(job.jobId)).text.trim(), "job-safe");
    const events = f.audit.events.filter(e => e.job?.jobId === job.jobId);
    assert.deepEqual(events.map(e => e.phase), ["attempted", "completed"]);
    assert.equal(events[0].auditId, result.auditId);
    await f.executor.shutdown();
    restored = new CommandExecutor(f.config, f.audit);
    assert.equal((await restored.jobs.start(input)).jobId, job.jobId);
    assert.equal((await restored.jobs.output(job.jobId)).text.trim(), "job-safe");
  } finally { await restored?.shutdown(); await f.close(); }
});

test("background policy rejects self modification and guarded deletion before child startup", async () => {
  const f = await fixture({ executionMode: "guarded" });
  try {
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: windows ? "Remove-Item 'missing-file'" : "rm -- missing-file" }));
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: windows ? "Set-Content '" + f.root + "\\record' x" : "touch '" + f.root + "/record'" }), /CommandBridge/);
    assert.equal(f.executor.availableCommandSlots, 1);
    assert.deepEqual(f.audit.events.map(e => e.phase), ["attempted", "blocked", "attempted", "blocked"]);
  } finally { await f.close(); }
});

test("queued jobs share synchronous capacity, recheck modes and support cancellation", async () => {
  const f = await fixture();
  try {
    const first = await f.executor.jobs.start({ requestId: randomUUID(), command: command('setTimeout(()=>{},20000)') });
    const deadline = performance.now() + 10000;
    while (f.executor.availableCommandSlots !== 0 && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(f.executor.availableCommandSlots, 0);
    const second = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" });
    assert.equal((await f.executor.jobs.get(second.jobId)).state, "queued");
    await assert.rejects(f.executor.execute({ command: "hostname" }), /parallel commands/);
    const cancelled = await f.executor.jobs.cancel(second.jobId);
    assert.equal(cancelled.state, "cancelled");
    const third = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" });
    f.config.executionMode = "guarded";
    await f.executor.jobs.cancel(first.jobId);
    assert.equal((await finished(f.executor, first.jobId)).state, "cancelled");
    assert.equal((await finished(f.executor, third.jobId)).errorCode, "JOB_POLICY_CHANGED");
    assert.equal(f.executor.availableCommandSlots, 1);
  } finally { await f.close(); }
});

test("terminal Audit failure withholds background output and rejects further execution", async () => {
  const f = await fixture();
  try {
    f.audit.failTerminal = true;
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" });
    const result = await finished(f.executor, job.jobId);
    assert.equal(result.auditStatus, "unavailable"); assert.equal(result.outputAvailable, false);
    await assert.rejects(f.executor.jobs.output(job.jobId));
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" }));
    assert.equal(f.executor.availableCommandSlots, 0);
  } finally { await f.close(); }
});

test("background timeout confirms termination and releases the shared command slot", async () => {
  const f = await fixture();
  try {
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: command("setInterval(()=>{},1000)"), timeoutMs: 1000 });
    const result = await finished(f.executor, job.jobId);
    assert.equal(result.state, "timed_out"); assert.equal(result.terminationStatus, "confirmed");
    assert.equal(f.executor.availableCommandSlots, 1);
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname", timeoutMs: 3600001 }), /maximum/);
  } finally { await f.close(); }
});

test("interrupted persisted jobs are never rerun and their output is withheld", async () => {
  const f = await fixture(); let restored: CommandExecutor | undefined;
  try {
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" }); await finished(f.executor, job.jobId);
    await f.executor.shutdown();
    const path = join(f.root, job.jobId + ".json"), record = JSON.parse(await readFile(path, "utf8"));
    record.state = "running"; record.endedAt = null;
    await writeFile(path, JSON.stringify(record));
    const count = f.audit.events.length;
    restored = new CommandExecutor(f.config, f.audit);
    const recovered = await restored.jobs.get(job.jobId);
    assert.equal(recovered.state, "interrupted"); assert.equal(recovered.auditStatus, "unknown");
    await assert.rejects(restored.jobs.output(job.jobId)); assert.equal(f.audit.events.length, count);
  } finally { await restored?.shutdown(); await f.close(); }
});

test("unsafe linked job records are rejected without reading their contents", { skip: windows }, async () => {
  const f = await fixture();
  try {
    await symlink(join(f.root, "missing"), join(f.root, randomUUID() + ".json"));
    await assert.rejects(f.executor.jobs.initialize(), /storage/);
  } finally { await f.close(); }
});

test("initial Audit failure never starts a background command", async () => {
  const f = await fixture();
  try {
    f.audit.write = async () => { throw new Error("Injected initial failure"); };
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" }));
    assert.equal((await f.executor.jobs.list()).jobs.length, 0);
  } finally { await f.close(); }
});

test("background output caps keep draining without killing the finite process", async () => {
  const f = await fixture();
  try {
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: command('process.stdout.write("x".repeat(6*1024*1024)); process.stderr.write("finished");'), timeoutMs: 20000 });
    const result = await finished(f.executor, job.jobId);
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false); assert.equal(result.truncated, true);
    assert.equal(result.state, "completed");
    const page = await f.executor.jobs.output(job.jobId);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536); assert.equal(page.text.length, 8000);
    assert.equal(f.executor.availableCommandSlots, 1);
  } finally { await f.close(); }
});

test("MCP background submission survives disconnect and rejects update while active", async () => {
  const f = await fixture({ transport: "http", bearerToken: "private-job-test-token-".repeat(3), httpPort: 0 });
  const server = await startHttpTransport(f.config, f.executor);
  let client = new Client({ name: "background-job-test", version: "1" });
  const transport = () => new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + (server.address() as AddressInfo).port + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + f.config.bearerToken } } });
  try {
    await client.connect(transport());
    const input = { requestId: randomUUID(), command: command("setTimeout(()=>{},20000)") };
    const submitted = await client.callTool({ name: "command_bridge_start_job", arguments: input });
    assert.notEqual(submitted.isError, true);
    const jobId = (submitted.structuredContent as {jobId:string}).jobId;
    await client.close();
    client = new Client({ name: "background-job-reconnected", version: "1" }); await client.connect(transport());
    const duplicate = await client.callTool({ name: "command_bridge_start_job", arguments: input });
    assert.equal((duplicate.structuredContent as {jobId:string}).jobId, jobId);
    const update = await client.callTool({ name: "command_bridge_update", arguments: {} });
    assert.equal((update.structuredContent as {error:{code:string}}).error.code, "UPDATE_JOBS_ACTIVE");
    const output = await client.callTool({ name: "command_bridge_read_job_output", arguments: { jobId } });
    assert.equal(output.isError, true);
    await client.callTool({ name: "command_bridge_cancel_job", arguments: { jobId } });
    assert.equal((await finished(f.executor, jobId)).state, "cancelled");
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test("allowlist background jobs retain literal argv policy and block shell control syntax", async () => {
  const f = await fixture({ executionMode: "allowlist" });
  try {
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" });
    assert.equal((await finished(f.executor, job.jobId)).state, "completed");
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname && hostname" }));
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname unexpected-argument" }));
  } finally { await f.close(); }
});

test("a second service cannot acquire active job storage", async () => {
  const f = await fixture(); const other = new CommandExecutor(f.config, f.audit);
  try { await f.executor.jobs.initialize(); await assert.rejects(other.jobs.initialize(), /storage/); }
  finally { await other.shutdown(); await f.close(); }
});

test("retention deletes expired complete output and retry identities during startup", async () => {
  const f = await fixture(); let other: CommandExecutor | undefined;
  try {
    const job = await f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" }); await finished(f.executor, job.jobId); await f.executor.shutdown();
    const path = join(f.root, job.jobId + ".json"), record = JSON.parse(await readFile(path, "utf8"));
    record.endedAt = Date.now() - 86400001; await writeFile(path, JSON.stringify(record));
    other = new CommandExecutor(f.config, f.audit);
    assert.equal((await other.jobs.list()).jobs.length, 0);
    await assert.rejects(other.jobs.get(job.jobId), /retained/);
  } finally { await other?.shutdown(); await f.close(); }
});

test("job storage faults fail readiness while independent diagnostics remain available", { skip: windows }, async () => {
  const f = await fixture();
  try {
    await f.executor.jobs.initialize(); await chmod(f.root, 0o755);
    await assert.rejects(f.executor.jobs.start({ requestId: randomUUID(), command: "hostname" }), /storage/);
    assert.equal((await f.executor.readiness()).ready, false);
    const report = await f.executor.diagnostics.get({});
    assert.equal(report.backgroundJobs!.storageAvailable, false);
    assert.ok(!JSON.stringify(report).includes(f.root));
  } finally { await chmod(f.root, 0o700); await f.close(); }
});
