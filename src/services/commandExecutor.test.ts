import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import type { AuditEventList, AuditLog, CommandAuditEvent } from "./auditLog.js";
import { CommandExecutor, type CommandResult } from "./commandExecutor.js";
import type { ShellKind } from "./commandPolicy.js";

class MemoryAuditLog implements AuditLog {
  readonly events: CommandAuditEvent[] = [];

  constructor(private readonly failOnWrite?: number) {}

  async write(event: CommandAuditEvent): Promise<void> {
    if (this.failOnWrite === this.events.length + 1) {
      throw new Error("audit writer rejected raw-command-output");
    }
    this.events.push(event);
  }

  async list(_limit: number): Promise<AuditEventList> {
    return { events: this.events, hasMore: false };
  }
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: "stdio",
    bearerToken: undefined,
    httpHost: "127.0.0.1",
    httpPort: 8800,
    allowedHosts: [],
    executionMode: "unrestricted",
    allowedShells: ["bash"],
    allowedCommands: new Set(["echo"]),
    allowedRoots: [process.cwd()],
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    maxOutputChars: 10_000,
    maxParallelCommands: 1,
    passthroughEnv: [],
    ...overrides
  };
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    shell: "bash",
    cwd: process.cwd(),
    exitCode: 0,
    signal: null,
    stdout: "safe output",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 14,
    ...overrides
  };
}

function stubRunProcess(
  executor: CommandExecutor,
  implementation: (
    shell: ShellKind,
    command: string,
    cwd: string,
    timeoutMs: number
  ) => Promise<CommandResult>
): void {
  Object.defineProperty(executor as object, "runProcess", {
    configurable: true,
    value: implementation
  });
}

test("successful commands produce attempted then completed lifecycle events without output", async () => {
  const audit = new MemoryAuditLog();
  const executor = new CommandExecutor(createConfig(), audit);
  let runCount = 0;
  stubRunProcess(executor, async () => {
    runCount += 1;
    return commandResult();
  });

  const result = await executor.execute({
    command: "echo --token super-secret-token",
    shell: "bash"
  });

  assert.equal(result.stdout, "safe output");
  assert.equal(runCount, 1);
  assert.deepEqual(audit.events.map((event) => event.phase), ["attempted", "completed"]);
  assert.equal(audit.events[0]?.auditId, audit.events[1]?.auditId);
  assert.doesNotMatch(audit.events[0]?.command ?? "", /super-secret-token/);
  assert.equal(audit.events[1]?.exitCode, 0);
  assert.equal(audit.events[1]?.errorCode, null);
  for (const event of audit.events) {
    assert.equal(Object.hasOwn(event, "stdout"), false);
    assert.equal(Object.hasOwn(event, "stderr"), false);
  }
});

test("policy rejections produce attempted then blocked events and never start a process", async () => {
  const audit = new MemoryAuditLog();
  const executor = new CommandExecutor(
    createConfig({ executionMode: "allowlist", allowedCommands: new Set(["echo"]) }),
    audit
  );
  let runCount = 0;
  stubRunProcess(executor, async () => {
    runCount += 1;
    return commandResult();
  });

  await assert.rejects(
    () => executor.execute({ command: "not-allowed --token super-secret-token", shell: "bash" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "COMMAND_NOT_ALLOWED");
      return true;
    }
  );

  assert.equal(runCount, 0);
  assert.deepEqual(audit.events.map((event) => event.phase), ["attempted", "blocked"]);
  assert.equal(audit.events[1]?.errorCode, "COMMAND_NOT_ALLOWED");
  assert.doesNotMatch(audit.events[1]?.command ?? "", /super-secret-token/);
});

test("process start failures produce a failed lifecycle event", async () => {
  const audit = new MemoryAuditLog();
  const executor = new CommandExecutor(createConfig(), audit);
  stubRunProcess(executor, async () => {
    throw new AppError(
      "COMMAND_START_FAILED",
      "The selected shell could not start.",
      "Install the shell."
    );
  });

  await assert.rejects(
    () => executor.execute({ command: "echo safe", shell: "bash" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "COMMAND_START_FAILED");
      return true;
    }
  );

  assert.deepEqual(audit.events.map((event) => event.phase), ["attempted", "failed"]);
  assert.equal(audit.events[1]?.errorCode, "COMMAND_START_FAILED");
});

test("timeout and truncation results remain completed events with explicit result codes", async () => {
  for (const [result, expectedCode] of [
    [
      commandResult({ ok: false, exitCode: null, signal: "SIGTERM", timedOut: true }),
      "COMMAND_TIMEOUT"
    ],
    [
      commandResult({ ok: false, exitCode: null, signal: "SIGTERM", truncated: true }),
      "COMMAND_OUTPUT_TRUNCATED"
    ]
  ] as const) {
    const audit = new MemoryAuditLog();
    const executor = new CommandExecutor(createConfig(), audit);
    stubRunProcess(executor, async () => result);

    const returned = await executor.execute({ command: "echo safe", shell: "bash" });

    assert.equal(returned.ok, false);
    assert.deepEqual(audit.events.map((event) => event.phase), ["attempted", "completed"]);
    assert.equal(audit.events[1]?.errorCode, expectedCode);
  }
});

test("an unavailable initial audit sink blocks command startup", async () => {
  const audit = new MemoryAuditLog(1);
  const executor = new CommandExecutor(createConfig(), audit);
  let runCount = 0;
  stubRunProcess(executor, async () => {
    runCount += 1;
    return commandResult();
  });

  await assert.rejects(
    () => executor.execute({ command: "echo safe", shell: "bash" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUDIT_LOG_WRITE_FAILED");
      return true;
    }
  );

  assert.equal(runCount, 0);
  assert.equal(audit.events.length, 0);
});

test("a terminal audit failure withholds command stdout and stderr", async () => {
  const audit = new MemoryAuditLog(2);
  const executor = new CommandExecutor(createConfig(), audit);
  stubRunProcess(executor, async () =>
    commandResult({
      stdout: "raw-command-output",
      stderr: "raw-command-error"
    })
  );

  await assert.rejects(
    () => executor.execute({ command: "echo safe", shell: "bash" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUDIT_LOG_WRITE_FAILED");
      assert.doesNotMatch((error as Error).message, /raw-command-output|raw-command-error/);
      return true;
    }
  );

  assert.deepEqual(audit.events.map((event) => event.phase), ["attempted"]);
});
