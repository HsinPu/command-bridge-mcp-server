import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/env.js";
import { CommandExecutor } from "./commandExecutor.js";
import { runFixedProcess, type AuditLog, type CommandAuditEvent } from "./auditLog.js";
import { runUpdateControl } from "./managedUpdate.js";
import { startDiagnosticProcess } from "./diagnosticProbe.js";

function fixtureConfig(root: string, mode: AppConfig["executionMode"] = "unrestricted"): AppConfig {
  return { transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: mode,
    allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(), allowedRoots: [root],
    defaultTimeoutMs: 15_000, maxTimeoutMs: 15_000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] };
}
function memoryAudit() {
  const events: CommandAuditEvent[] = [];
  const audit: AuditLog = { async write(event) { events.push(event); }, async list() { return { events, hasMore: false }; } };
  return { audit, events };
}
const quote = (value: string) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const text = "你好🙂";
const emitter = (value: string, stderr = false, trailing = false) => `const b=Buffer.from(${JSON.stringify(value)});for(const n of b){process.stdout.write(Buffer.from([n]));${stderr ? "process.stderr.write(Buffer.from([n]));" : ""}await new Promise(r=>setTimeout(r,20));}${trailing ? "process.stdout.write(Buffer.from([0xe4]));" : ""}`;

test("command stdout and stderr retain split UTF-8 and a single terminal Audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-utf8-"));
  const { audit, events } = memoryAudit();
  const executor = new CommandExecutor(fixtureConfig(root), audit);
  try {
    const program = join(root, "emit.mjs"); await writeFile(program, emitter(text, true, true));
    const result = await executor.execute({ command: `${quote(process.execPath)} ${quote(program)}`, cwd: root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stdout, text + "\uFFFD"); assert.equal(result.stderr, text);
    assert.equal(result.timedOut, false); assert.equal(result.truncated, false);
    assert.deepEqual(events.map(e => e.phase), ["attempted", "completed"]);
    assert.ok(!JSON.stringify(events).includes(text));
  } finally { await executor.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("fixed Audit, update and diagnostic helpers decode split UTF-8", async () => {
  const value = JSON.stringify({ value: text });
  const args = ["--input-type=module", "-e", emitter(value)];
  assert.equal(await runFixedProcess(process.execPath, args), value);
  assert.equal(await runUpdateControl(process.execPath, args), value);
  assert.deepEqual(await startDiagnosticProcess(process.execPath, args, process.env, 5000).result, { value: text });
});

test("UTF-8 caps retain complete characters and helper bounds remain enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-utf8-limit-"));
  const cfg = fixtureConfig(root); cfg.maxOutputChars = 3;
  const executor = new CommandExecutor(cfg, memoryAudit().audit);
  try {
    const program = join(root, "emit.mjs"); await writeFile(program, emitter("你🙂好") + "setInterval(()=>{},1000)");
    const result = await executor.execute({ command: `${quote(process.execPath)} ${quote(program)}`, cwd: root });
    assert.equal(result.truncated, true); assert.equal(result.stdout, "你🙂");
    assert.ok(result.stdout.length <= 3);
    await assert.rejects(runUpdateControl(process.execPath, ["-e", "process.stdout.write('x'.repeat(8193))"]), /did not acknowledge/);
    await assert.rejects(startDiagnosticProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(32769))"], process.env).result, /unavailable/);
  } finally { await executor.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("Windows cmd preserves quoted executable paths, arguments and shell escaping", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb cmd spaces "));
  try {
    const bin = join(root, "node space.exe"); await copyFile(process.execPath, bin);
    const program = join(root, "print arguments.mjs"); await writeFile(program, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    for (const mode of ["unrestricted", "guarded"] as const) {
      const executor = new CommandExecutor(fixtureConfig(root, mode), memoryAudit().audit);
      try {
        const result = await executor.execute({ command: `"${bin}" "${program}" "hello world" "" "a&b"`, cwd: root });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(JSON.parse(result.stdout), ["hello world", "", "a&b"]);
        const quoted = await executor.execute({ command: 'echo "quoted text"', cwd: root });
        assert.equal(quoted.stdout.trim(), '"quoted text"');
        await assert.rejects(executor.execute({ command: 'del "C:\\ProgramData\\CommandBridgeMCP\\command-bridge.env"', cwd: root }), /own configuration/);
      } finally { await executor.shutdown(); }
    }
    const executor = new CommandExecutor(fixtureConfig(root), memoryAudit().audit);
    try {
      for (const [command, expected] of [['echo a^&b', 'a&b'], ['echo %COMSPEC%', undefined]]) {
        const result = await executor.execute({ command: command!, cwd: root });
        assert.equal(result.ok, true); if (expected) assert.equal(result.stdout.trim(), expected);
        else assert.match(result.stdout, /cmd\.exe/i);
      }
    } finally { await executor.shutdown(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
