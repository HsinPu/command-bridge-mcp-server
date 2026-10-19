import assert from "node:assert/strict";
import test from "node:test";
import { CommandQuarantine, CommandExecutionError, ProcessTerminationError, terminationConfirmed } from "./commandTermination.js";
import { CommandExecutor, terminateProcessTree } from "./commandExecutor.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "../config/env.js";
import type { CommandAuditEvent } from "./auditLog.js";

test("quarantine reserves capacity until confirmation and recovers exactly once", () => {
  const quarantine = new CommandQuarantine();
  let confirmed = false;
  try {
    quarantine.hold("a", () => confirmed);
    assert.equal(quarantine.size, 1);
    confirmed = true;
    assert.equal(quarantine.size, 0);
    assert.equal(quarantine.size, 0);
  } finally { quarantine.stop(); }
});

test("real Linux UID boundary quarantines a root child and recovers after its natural exit", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, () => {
  const moduleUrl = new URL("./commandExecutor.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {CommandExecutor} from ${JSON.stringify(moduleUrl)};
    const events=[];
    const executor=new CommandExecutor({transport:'stdio',httpHost:'127.0.0.1',httpPort:8800,allowedHosts:[],executionMode:'unrestricted',allowedShells:['bash'],allowedCommands:new Set(),allowedRoots:['/tmp'],defaultTimeoutMs:1000,maxTimeoutMs:1000,maxOutputChars:1000,maxParallelCommands:1,passthroughEnv:[]},{async write(e){events.push(e)},async list(){return {events,hasMore:false}}});
    try {
      const pending=executor.execute({command:'sleep 2',cwd:'/tmp'});
      const rejected=assert.rejects(pending,e=>e.code==='COMMAND_TERMINATION_FAILED' && e.evidence.reason==='EPERM' && e.evidence.timedOut);
      while(executor.availableCommandSlots!==0) await new Promise(r=>setTimeout(r,10));
      process.setgroups([]); process.setgid(65534); process.setuid(65534);
      await rejected;
      assert.equal(executor.availableCommandSlots,0);
      assert.equal(events.at(-1).timedOut,true);
      await new Promise(r=>setTimeout(r,2500));
      assert.equal(executor.availableCommandSlots,1);
      assert.equal((await executor.execute({command:'printf ok',cwd:'/tmp'})).stdout,'ok');
    } finally {await executor.shutdown()}
    console.log('UID boundary recovery passed');
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(output, /UID boundary recovery passed/);
});

test("Linux termination distinguishes permission, group deadline and open streams without leaking causes", { skip: process.platform !== "linux" }, async t => {
  const child = Object.assign(new EventEmitter(), { pid: 2147483646, exitCode: 0, signalCode: null, stdout: { readableEnded: false }, stderr: { readableEnded: true } }) as unknown as ChildProcess;
  let exists = true;
  let permission = true;
  const kill = t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    if (signal === 0 && permission) throw Object.assign(new Error("private cause"), { code: "EPERM" });
    if (signal === 0 && !exists) throw Object.assign(new Error(), { code: "ESRCH" });
    return true;
  });
  try {
    await assert.rejects(terminateProcessTree(child), (e: any) => e instanceof ProcessTerminationError && e.stage === "group-check" && e.reason === "EPERM");
    assert.equal(terminationConfirmed(child), false);
    permission = false;
    await assert.rejects(terminateProcessTree(child), (e: any) => e instanceof ProcessTerminationError && e.stage === "deadline" && e.reason === "deadline-exceeded");
    exists = false;
    assert.equal(terminationConfirmed(child), false);
    Object.assign(child.stdout!, { readableEnded: true });
    assert.equal(terminationConfirmed(child), true);
  } finally { kill.mock.restore(); }
});

test("Linux permission failure preserves output trigger, flags, bounded capacity and automatic recovery", { skip: process.platform !== "linux" }, async t => {
  const events: CommandAuditEvent[] = [];
  const config: AppConfig = { transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: "unrestricted", allowedShells: ["bash"], allowedCommands: new Set(), allowedRoots: [process.cwd()], defaultTimeoutMs: 10000, maxTimeoutMs: 15000, maxOutputChars: 10, maxParallelCommands: 1, passthroughEnv: [] };
  const executor = new CommandExecutor(config, { async write(e) { events.push(e); }, async list() { return { events, hasMore: false }; } });
  const originalKill = process.kill.bind(process);
  const kill = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0 && signal !== 0) throw Object.assign(new Error("private injected details"), { code: "EPERM" });
    return originalKill(pid, signal as NodeJS.Signals | number);
  });
  t.mock.method(console, "error", () => undefined);
  try {
    await assert.rejects(executor.execute({ command: "printf 'abcdefghijklmnopqrst'; sleep 1.5" }), (e: unknown) => {
      assert.ok(e instanceof CommandExecutionError);
      assert.equal(e.code, "COMMAND_TERMINATION_FAILED");
      assert.equal(e.evidence.trigger, "output-limit");
      assert.equal(e.evidence.reason, "EPERM");
      assert.equal(e.evidence.truncated, true);
      assert.equal(e.evidence.timedOut, false);
      assert.equal(e.evidence.outputChars, 20);
      return true;
    });
    assert.equal(events.at(-1)?.truncated, true);
    assert.ok(events.at(-1)?.durationMs !== null);
    assert.equal(executor.availableCommandSlots, 0);
    const diagnostics = await executor.diagnostics.get();
    assert.equal(diagnostics.mode, "degraded");
    assert.equal(diagnostics.recentRequests[0].execution?.reason, "EPERM");
    assert.equal((await executor.readiness()).checks.terminationConfirmed, false);
    await assert.rejects(executor.execute({ command: "printf ok" }), (e: any) => e.code === "COMMAND_TERMINATION_UNCONFIRMED");
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(executor.availableCommandSlots, 1);
    assert.equal(executor.acceptingCommands, true);
    assert.equal((await executor.execute({ command: "printf ok" })).stdout, "ok");
    assert.equal(events.filter(e => e.phase === "failed").length, 1);
    config.maxOutputChars = 1000;
    config.defaultTimeoutMs = 1000;
    await assert.rejects(executor.execute({ command: "sleep 1.5" }), (e: any) => e.evidence.trigger === "timeout" && e.evidence.timedOut && e.evidence.reason === "EPERM");
    assert.equal(events.at(-1)?.timedOut, true);
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(executor.availableCommandSlots, 1);
    config.defaultTimeoutMs = 10000;
    const controller = new AbortController();
    const cancelled = executor.execute({ command: "sleep 1.5" }, controller.signal);
    const rejected = assert.rejects(cancelled, (e: any) => e.evidence.trigger === "client-cancel" && e.evidence.cancelled && !e.evidence.timedOut);
    while (executor.availableCommandSlots !== 0) await new Promise(r => setTimeout(r, 10));
    controller.abort();
    await rejected;
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(executor.availableCommandSlots, 1);
    const stopping = executor.execute({ command: "sleep 1.5" });
    const stopped = assert.rejects(stopping, (e: any) => e.evidence.trigger === "service-shutdown" && e.evidence.cancelled);
    while (executor.availableCommandSlots !== 0) await new Promise(r => setTimeout(r, 10));
    await executor.shutdown();
    await stopped;
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(events.filter(e => e.phase === "failed").length, 4);
  } finally { kill.mock.restore(); await executor.shutdown(); }
});
