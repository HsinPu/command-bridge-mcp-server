import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config/env.js";
import { CommandExecutor, buildChildEnvironment } from "./commandExecutor.js";
import { runFixedProcess, type AuditLog, type CommandAuditEvent } from "./auditLog.js";
import { runUpdateControl } from "./managedUpdate.js";
import { startDiagnosticProcess } from "./diagnosticProbe.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHttpTransport } from "../transport/httpTransport.js";

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
function assertSucceeded(result: Awaited<ReturnType<CommandExecutor["execute"]>>, stage: string): void {
  const detail = JSON.stringify({ stage, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, durationMs: result.durationMs });
  assert.equal(result.ok, true, detail); assert.equal(result.exitCode, 0, detail);
  assert.equal(result.timedOut, false, detail); assert.equal(result.truncated, false, detail);
}
const quote = (value: string) => process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
const text = "你好🙂";
const emitter = (value: string, stderr = false, trailing = false) => `const b=Buffer.from(${JSON.stringify(value)});for(const n of b){process.stdout.write(Buffer.from([n]));${stderr ? "process.stderr.write(Buffer.from([n]));" : ""}await new Promise(r=>setTimeout(r,20));}${trailing ? "process.stdout.write(Buffer.from([0xe4]));" : ""}`;

test("command stdout and stderr retain split UTF-8 and a single terminal Audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-utf8-"));
  const { audit, events } = memoryAudit();
  const executor = new CommandExecutor(fixtureConfig(root), audit);
  try {
    const program = join(root, "emit.mjs"); await writeFile(program, emitter(text, true));
    const result = await executor.execute({ command: `${quote(process.execPath)} ${quote(program)}`, cwd: root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stdout, text); assert.equal(result.stderr, text);
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
  for (const bytes of ["ff", "e4"]) {
    const malformed = ["-e", `process.stdout.write(Buffer.from('${bytes}','hex'))`];
    await assert.rejects(runFixedProcess(process.execPath, malformed), /not valid UTF-8/);
    await assert.rejects(runUpdateControl(process.execPath, malformed), /did not acknowledge/);
    await assert.rejects(startDiagnosticProcess(process.execPath, malformed, process.env, 5000).result, /unavailable|Invalid diagnostic/);
  }
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

test("incorrect UTF-8 withholds both streams, records failed Audit once and releases the command slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-bad-encoding-"));
  const { audit, events } = memoryAudit(), executor = new CommandExecutor(fixtureConfig(root), audit);
  try {
    const program = join(root, "emit.mjs"); await writeFile(program, emitter("sensitive-captured-output") + "process.stderr.write(Buffer.from([0xff]));setInterval(()=>{},1000)");
    await assert.rejects(executor.execute({ command: `${quote(process.execPath)} ${quote(program)}`, cwd: root }), (error: any) => error.code === "COMMAND_OUTPUT_ENCODING_INVALID" && !JSON.stringify(error).includes("sensitive-captured-output"));
    assert.deepEqual(events.map(e => e.phase), ["attempted", "failed"]);
    assert.equal(events[1]!.errorCode, "COMMAND_OUTPUT_ENCODING_INVALID");
    assert.equal((executor as any).recentDiagnostics.list(events[1]!.auditId, 1)[0].errorCode, "COMMAND_OUTPUT_ENCODING_INVALID");
    await writeFile(program, emitter(text, true, true));
    await assert.rejects(executor.execute({ command: `${quote(process.execPath)} ${quote(program)}` }), (error: any) => error.code === "COMMAND_OUTPUT_ENCODING_INVALID");
    await writeFile(program, emitter(text));
    assert.equal((await executor.execute({ command: `${quote(process.execPath)} ${quote(program)}` })).stdout, text);
    await assert.rejects(executor.execute({ command: "unused", outputEncoding: "auto" as any }), (error: any) => error.code === "OUTPUT_ENCODING_INVALID");
    assert.deepEqual(events.slice(-2).map(e => e.phase), ["attempted", "blocked"]);
  } finally { await executor.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("MCP HTTP retains Chinese output and explicit legacy decoding through the registered tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-mcp-encoding-"));
  const cfg = fixtureConfig(root); cfg.transport = "http"; cfg.httpPort = 0; cfg.bearerToken = "encoding-test-".repeat(4);
  const { audit, events } = memoryAudit(), executor = new CommandExecutor(cfg, audit), client = new Client({ name: "encoding-test", version: "1" });
  const server = await startHttpTransport(cfg, executor);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${cfg.bearerToken}` } } }));
    const program = join(root, "emit.mjs");
    for (const [encoding, bytes, expected] of [["utf8", Buffer.from(text), text], ["big5", Buffer.from("a4a4a4e5", "hex"), "中文"], ["gbk", Buffer.from("d6d0cec4", "hex"), "中文"], ["utf16le", Buffer.from(text, "utf16le"), text]] as const) {
      await writeFile(program, `const b=Buffer.from('${bytes.toString("hex")}','hex');for(const n of b){process.stdout.write(Buffer.from([n]));process.stderr.write(Buffer.from([n]));await new Promise(r=>setTimeout(r,10));}`);
      if (encoding === "big5") {
        const invalid = await client.callTool({ name: "command_bridge_run_command", arguments: { command: `${quote(process.execPath)} ${quote(program)}`, cwd: root } });
        assert.equal(invalid.isError, true);
        assert.equal((invalid.structuredContent as any).error.code, "COMMAND_OUTPUT_ENCODING_INVALID");
        assert.equal((invalid.structuredContent as any).stdout, undefined);
      }
      const result = await client.callTool({ name: "command_bridge_run_command", arguments: { command: `${quote(process.execPath)} ${quote(program)}`, cwd: root, outputEncoding: encoding } });
      assert.equal(result.isError, false, JSON.stringify(result));
      const body = result.structuredContent as any;
      assert.equal(body.ok, true, JSON.stringify(body)); assert.equal(body.stdout, expected); assert.equal(body.stderr, expected);
    }
    assert.deepEqual(events.map(e => e.phase), ["attempted", "completed", "attempted", "failed", "attempted", "completed", "attempted", "completed", "attempted", "completed"]);
  } finally { await client.close(); await executor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("real stdio MCP and file Audit retain Chinese commands and output without touching user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-stdio-中文-")), client = new Client({ name: "unicode-stdio", version: "1" });
  const env = Object.fromEntries(Object.entries(buildChildEnvironment([])).filter((pair): pair is [string,string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], cwd: root, stderr: "pipe", env: {
    ...env, LOCALAPPDATA: root, XDG_DATA_HOME: root, DOTENV_CONFIG_PATH: join(root, "absent.env"),
    COMMAND_BRIDGE_AUDIT_BACKEND: "file", COMMAND_BRIDGE_TRANSPORT: "stdio", COMMAND_BRIDGE_EXECUTION_MODE: "unrestricted",
    COMMAND_BRIDGE_ALLOWED_ROOTS: root, COMMAND_BRIDGE_ALLOWED_SHELLS: process.platform === "win32" ? "cmd" : "sh"
  } });
  try {
    // Consume the private server's stderr without logging paths or environment.
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
    const command = `echo ${text}`;
    const result = await client.callTool({ name: "command_bridge_run_command", arguments: { command } });
    const diagnostic = result.isError ? await client.callTool({ name: "command_bridge_get_diagnostics", arguments: {} }) : undefined;
    assert.equal(result.isError, false, JSON.stringify({ error: (result.structuredContent as any)?.error?.code, audit: (diagnostic?.structuredContent as any)?.audit }));
    assert.equal((result.structuredContent as any).stdout.trim(), text);
    const audit = await client.callTool({ name: "command_bridge_list_audit_events", arguments: { limit: 10 } });
    const events = (audit.structuredContent as { events: CommandAuditEvent[] }).events.filter(e => e.command === command);
    assert.deepEqual(events.map(e => e.phase).sort(), ["attempted", "completed"]);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});

test("Windows cmd and PowerShell return Unicode text and explicitly edit complete UTF-8 files", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cb-中文🙂-"));
  const file = join(root, "中文文件.txt"), original = "首行中文🙂\r\n第二行保留\r\nlast\r\n";
  const cfg = fixtureConfig(root); cfg.allowedShells = ["cmd", "powershell"];
  const executor = new CommandExecutor(cfg, memoryAudit().audit);
  try {
    await writeFile(file, original);
    const echo = await executor.execute({ command: `echo ${text}` }); assertSucceeded(echo, "cmd-echo"); assert.equal(echo.stdout.trim(), text);
    const type = await executor.execute({ command: `type "${file}"` }); assertSucceeded(type, "cmd-read"); assert.equal(type.stdout, original);
    const escaped = file.replaceAll("'", "''");
    const read = await executor.execute({ shell: "powershell", command: `[Console]::Out.Write((Get-Content -LiteralPath '${escaped}' -Raw -Encoding UTF8))` });
    assertSucceeded(read, "powershell-read"); assert.equal(read.stdout, original);
    const { readFile } = await import("node:fs/promises");
    const edit = await executor.execute({ shell: "powershell", command: `$t=Get-Content -LiteralPath '${escaped}' -Raw -Encoding UTF8; [IO.File]::WriteAllText('${escaped}', $t.Replace('首行','修改首行'), [Text.UTF8Encoding]::new($false,$true))` });
    assertSucceeded(edit, "powershell-edit");
    assert.deepEqual(await readFile(file), Buffer.from(original.replace("首行", "修改首行")));
    const unsuccessful = await executor.execute({ command: "exit /b 7" }); assert.equal(unsuccessful.exitCode, 7); assert.equal(unsuccessful.ok, false);
  } finally { await executor.shutdown(); await rm(root, { recursive: true, force: true }); }
});
