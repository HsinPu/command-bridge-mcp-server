import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { AuditLog, CommandAuditEvent } from "./auditLog.js";
import { ManagedUpdateService, runUpdateControl, updateJobSchema, type UpdateAdapter, type UpdateJob } from "./managedUpdate.js";
import { assertNoSelfModification } from "./selfProtection.js";

const cfg = { transport: "http", executionMode: "guarded" } as AppConfig;
function fixture(failAt = 0) {
  const events: CommandAuditEvent[] = [];
  const audit: AuditLog = { async write(event) { if (events.length + 1 === failAt) throw Error("Audit rejected"); events.push(event); }, async list() { return { events, hasMore: false }; } };
  const job: UpdateJob = { schemaVersion: 1, jobId: randomUUID(), state: "accepted", startedAt: new Date().toISOString(), finishedAt: null, before: { version: "4.4.0", sourceSha: "a".repeat(40) }, after: null, errorCode: null };
  let calls = 0;
  const adapter: UpdateAdapter = { async start() { calls++; return job; }, async status() { return job; } };
  return { audit, events, adapter, job, calls: () => calls };
}
test("managed updates default to enabled and Audit records acceptance, not installation success", async () => {
  const f = fixture(), service = new ManagedUpdateService(cfg, f.audit, f.adapter);
  assert.deepEqual(await service.start(), f.job);
  assert.deepEqual(f.events.map(e => e.phase), ["attempted", "completed"]);
  assert.equal(f.events[0]!.auditId, f.events[1]!.auditId);
  assert.ok(f.events[1]!.command.includes(f.job.jobId));
  assert.deepEqual(await service.status(f.job.jobId), f.job);
});
test("disabled, stopping and cancelled requests never reach the privileged adapter", async () => {
  for (const mode of ["disabled", "stopping", "cancelled"]) {
    const f = fixture(), service = new ManagedUpdateService({ ...cfg, mcpUpdateEnabled: mode !== "disabled" }, f.audit, f.adapter);
    if (mode === "stopping") service.stop();
    const controller = new AbortController(); if (mode === "cancelled") controller.abort();
    await assert.rejects(service.start(controller.signal), /disabled or stopping/);
    assert.equal(f.calls(), 0); assert.deepEqual(f.events.map(e => e.phase), ["attempted", "blocked"]);
  }
});
test("initial Audit failure prevents update and terminal Audit failure reports an accepted job may exist", async () => {
  const first = fixture(1); await assert.rejects(new ManagedUpdateService(cfg, first.audit, first.adapter).start(), /Audit rejected/); assert.equal(first.calls(), 0);
  const final = fixture(2); const service = new ManagedUpdateService(cfg, final.audit, final.adapter);
  await assert.rejects(service.start(), /may already be running/); assert.equal(final.calls(), 1); assert.deepEqual(await service.status(), final.job);
});
test("concurrent MCP requests share one adapter request and failures release the admission slot", async () => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const original = f.adapter.start; f.adapter.start = async () => { await wait; return original(); };
  const service = new ManagedUpdateService(cfg, f.audit, f.adapter), a = service.start(), b = service.start();
  release(); await Promise.all([a,b]); assert.equal(f.calls(), 1);
  assert.equal(f.events.filter(event => event.phase === "attempted").length, 2);
  assert.equal(f.events.filter(event => event.phase === "completed").length, 2);
  assert.equal(new Set(f.events.map(event => event.auditId)).size, 2);
  f.adapter.start = async () => { throw Error("control failed"); };
  await assert.rejects(service.start(), /control failed/); assert.equal(f.events.at(-1)!.phase, "failed");
  f.adapter.start = original; await service.start(); assert.equal(f.calls(), 2);
});
test("job schema rejects extra commands, URLs and invalid source identifiers", () => {
  const { job } = fixture(); assert.ok(updateJobSchema.safeParse(job).success);
  for (const extra of [{ command: "anything" }, { url: "https://example.com" }, { jobId: "../latest" }, { before: { version: "4.4.0", sourceSha: "main" } }]) assert.equal(updateJobSchema.safeParse({ ...job, ...extra }).success, false);
});
test("control invocation bounds output/time and does not inherit Node injection options", async () => {
  const before = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = "--this-option-must-not-be-inherited";
  try { assert.equal(await runUpdateControl(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok"); }
  finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
  await assert.rejects(runUpdateControl(process.execPath, ["-e", "process.stdout.write('x'.repeat(9000));setInterval(()=>{},1000)"]), /did not acknowledge/);
  await assert.rejects(runUpdateControl(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100), /did not acknowledge/);
  await assert.rejects(runUpdateControl(process.execPath, ["-e", "process.stderr.write('secret');process.exit(1)"]), /did not acknowledge/);
});
test("recognizable direct worker changes/triggers remain blocked by command self-protection", () => {
  for (const command of ["sudo /usr/local/libexec/command-bridge-update/request", "sudo systemctl start command-bridge-update.service", "sudo rm /var/lib/command-bridge-update/latest.json"])
    assert.throws(() => assertNoSelfModification(command, "/tmp", { platform: "linux" }), { code: "SELF_MODIFICATION_BLOCKED" });
  for (const command of ['powershell -File "C:\\Program Files\\CommandBridgeUpdate\\request.ps1"', 'schtasks /run /tn CommandBridgeUpdate', 'del C:\\ProgramData\\CommandBridgeUpdate\\latest.json'])
    assert.throws(() => assertNoSelfModification(command, "C:\\work", { platform: "win32" }), { code: "SELF_MODIFICATION_BLOCKED" });
});
test("root controller accepts only a unique, literal boolean setting and complete SHA metadata", async () => {
  const helper = await import(new URL("../../scripts/managed-update/state.mjs", import.meta.url).href);
  assert.equal(helper.updateEnabled("OTHER=true\n"), true);
  assert.equal(helper.updateEnabled("COMMAND_BRIDGE_MCP_UPDATE_ENABLED=false # disabled\n"), false);
  assert.equal(helper.updateEnabled('COMMAND_BRIDGE_MCP_UPDATE_ENABLED="false"\n'), false);
  assert.throws(() => helper.updateEnabled("COMMAND_BRIDGE_MCP_UPDATE_ENABLED=true\nCOMMAND_BRIDGE_MCP_UPDATE_ENABLED=false"));
  assert.throws(() => helper.updateEnabled("COMMAND_BRIDGE_MCP_UPDATE_ENABLED=$(id)"));
  assert.throws(() => helper.safeInfo({ version: "4.4.0", sourceSha: "main" }));
});


test("MCP wire rejects update arguments and recovers job status after reconnect", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerCommandBridgeTools } = await import("../tools/commandBridgeTools.js");
  const f = fixture(), updates = new ManagedUpdateService(cfg, f.audit, f.adapter);
  for (const phase of ["start", "reconnect"]) {
    const server = new McpServer({ name: "update-wire", version: "1.0.0" });
    const fake = { updates } as unknown as import("./commandExecutor.js").CommandExecutor;
    registerCommandBridgeTools(server, cfg, fake);
    const client = new Client({ name: "update-client", version: "1.0.0" });
    const [a,b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      if (phase === "start") {
        const invalid = await client.callTool({ name: "command_bridge_update", arguments: { url: "https://example.com", command: "shell" } });
        assert.equal(invalid.isError, true); assert.equal(f.calls(), 0);
        const accepted = await client.callTool({ name: "command_bridge_update", arguments: {} });
        assert.equal(accepted.isError, false); assert.deepEqual(accepted.structuredContent, f.job);
        f.job.state = "succeeded"; f.job.after = f.job.before; f.job.finishedAt = new Date().toISOString();
      } else {
        const status = await client.callTool({ name: "command_bridge_get_update_status", arguments: { jobId: f.job.jobId } });
        assert.deepEqual(status.structuredContent, f.job);
        const invalid = await client.callTool({ name: "command_bridge_get_update_status", arguments: { jobId: "../latest" } });
        assert.equal(invalid.isError, true);
      }
    } finally { await client.close(); await server.close(); }
  }
});


test("disposable fixture pins one SHA and archive without relaxing production bootstrap validation", async () => {
  const {readFile} = await import("node:fs/promises");
  const helper = await import(new URL("../../scripts/tests/managed-update-fixture.mjs", import.meta.url).href);
  for (const [platform, file, archive] of [["linux","bootstrap.sh","/tmp/archive ' safe.tar.gz"],["win32","bootstrap.ps1","C:\\Temp\\archive ' safe.zip"]]) {
    const original = await readFile(new URL("../../scripts/"+file, import.meta.url), "utf8");
    const changed = helper.fixtureBootstrap(original,platform,"4".repeat(40),"4.4.0",archive);
    assert.ok(changed.includes("4".repeat(40)));
    assert.ok(changed.includes("Invalid installation channel"));
    assert.equal(changed.includes("archive/${sha}"),false);
    assert.throws(()=>helper.fixtureBootstrap("wrong anchors",platform,"4".repeat(40),"4.4.0",archive));
    assert.throws(()=>helper.fixtureBootstrap(original,platform,"main","4.4.0",archive));
  }
});


test("control diagnostics expose only validated numeric locations", async () => {
  await assert.rejects(runUpdateControl(process.execPath,["-e","console.log(JSON.stringify({controlError:true,stage:2,hresult:-2147024891,line:8}));process.exit(1)"]),/control-stage=2, hresult=-2147024891, line=8/);
  await assert.rejects(runUpdateControl(process.execPath,["-e","console.log(JSON.stringify({controlError:true,stage:2,hresult:0,line:8,secret:'must-stay-hidden'}));process.exit(1)"]), error=>error instanceof Error && !error.message.includes("must-stay-hidden") && !error.message.includes("control-stage"));
});


test("Linux deployment permissions remain readable under strict updater umask", {skip:process.platform!=="linux"}, async()=>{
 const {spawnSync}=await import("node:child_process");
 const result=spawnSync("bash",["scripts/linux-systemd/tests/program-permissions.test.sh"],{encoding:"utf8",timeout:15000});
 assert.equal(result.status,0,result.stderr);
});
test("real Windows request script retains numeric diagnostics with restricted environment", {skip:process.platform!=="win32"}, async()=>{
 const fs=await import("node:fs/promises"), os=await import("node:os"), path=await import("node:path");
 const fixture=await fs.mkdtemp(path.join(os.tmpdir(),"cb-control-regression-"));
 try {
  await fs.copyFile("scripts/managed-update/request.ps1",path.join(fixture,"request.ps1"));
  await fs.writeFile(path.join(fixture,"common.ps1"),(await fs.readFile("scripts/managed-update/common.ps1","utf8"))+"\nfunction Read-UpdateRecord { throw 'No record' }\nfunction Get-UpdateTask { throw [InvalidOperationException]::new('Fixture failure') }\n");
  const ps=path.join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe");
  await assert.rejects(runUpdateControl(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(fixture,"request.ps1")]),/control-stage=2/);
 } finally {await fs.rm(fixture,{recursive:true,force:true});}
});
