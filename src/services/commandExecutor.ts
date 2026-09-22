import { spawn, type ChildProcess } from "node:child_process";
import { access, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import {
  assertCommandAllowed,
  resolveWorkingDirectory,
  resolveSafeCommand,
  type ShellKind
} from "./commandPolicy.js";
import {
  createAuditEvent,
  createAuditLog,
  type AuditEventList,
  type AuditLog,
  type CommandAuditEvent
} from "./auditLog.js";

export interface CommandRequest {
  command: string;
  shell?: ShellKind;
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  ok: boolean;
  shell: ShellKind;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

interface ShellInvocation {
  executable: string;
  args: string[];
}

const defaultEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "WINDIR"
];

export class CommandExecutor {
  private activeCommands = 0;
  private stopping = false;
  private readonly running = new Set<() => void>();
  private readonly pending = new Set<Promise<CommandResult>>();

  constructor(
    private readonly config: AppConfig,
    private readonly auditLog: AuditLog = createAuditLog(config)
  ) {}

  execute(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const operation = this.executeInternal(request, signal);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const stop of this.running) stop();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded.")), 15_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async readiness(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    const checks: Record<string, boolean> = { accepting: !this.stopping, workingDirectory: true, shells: true, audit: true };
    try { for (const root of this.config.allowedRoots) await access(root, constants.R_OK | constants.X_OK); }
    catch { checks.workingDirectory = false; }
    if (this.config.policyFile) {
      checks.policyReadable = true;
      try { await access(this.config.policyFile, constants.R_OK); } catch { checks.policyReadable = false; }
      checks.policyReadOnly = true;
      try { const handle = await open(this.config.policyFile, "r+"); await handle.close(); checks.policyReadOnly = false; }
      catch { /* Actual opens enforce Windows DACLs, unlike fs.access. */ }
      const probe = join(dirname(this.config.policyFile), ".command-bridge-permission-" + randomUUID());
      try { const handle = await open(probe, "wx", 0o600); await handle.close(); await unlink(probe); checks.policyReadOnly = false; }
      catch { /* The service must not be able to replace its policy. */ }
    }
    for (const shell of this.config.allowedShells) {
      const executable = buildShellInvocation(shell, "").executable;
      const paths = isAbsolute(executable) ? [executable] : (process.env.PATH ?? "").split(delimiter).map(p => join(p, executable));
      const found = await Promise.all(paths.map(p => access(p, constants.X_OK).then(() => true, () => false)));
      if (!found.some(Boolean)) checks.shells = false;
    }
    try {
      await this.auditLog.write(createAuditEvent({ command: "CommandBridge readiness verification", phase: "completed", executionMode: this.config.executionMode, source: this.auditSource() }));
      await this.auditLog.list(1);
    } catch { checks.audit = false; }
    return { ready: Object.values(checks).every(Boolean), checks };
  }

  private async executeInternal(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const requestedShell = request.shell ?? this.config.allowedShells[0] ?? null;
    const requestedCwd = request.cwd ?? this.config.allowedRoots[0] ?? null;
    const attempted = createAuditEvent({
      phase: "attempted",
      command: request.command,
      shell: requestedShell,
      cwd: requestedCwd,
      executionMode: this.config.executionMode,
      source: this.auditSource()
    });

    // This is intentionally before policy checks and before spawn. Without the attempt
    // record, CommandBridge must not start a process.
    await this.writeAuditEvent(attempted);

    let shell: ShellKind;
    let cwd: string;
    let timeoutMs: number;

    try {
      if (this.stopping || signal?.aborted) throw new AppError("COMMAND_CANCELLED", "The command was cancelled or the service is stopping.");
      if (this.activeCommands >= this.config.maxParallelCommands) {
        throw new AppError(
          "COMMAND_CONCURRENCY_LIMIT",
          "The maximum number of parallel commands is already running.",
          "Wait for an existing command to finish and try again."
        );
      }

      if (!requestedShell) {
        throw new AppError(
          "NO_SHELL_CONFIGURED",
          "No command shell is configured.",
          "Set COMMAND_BRIDGE_ALLOWED_SHELLS."
        );
      }

      shell = requestedShell;
      assertCommandAllowed(this.config, shell, request.command);
      cwd = resolveWorkingDirectory(this.config.allowedRoots, request.cwd);
      timeoutMs = clampTimeout(
        request.timeoutMs,
        this.config.defaultTimeoutMs,
        this.config.maxTimeoutMs
      );
    } catch (error) {
      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "blocked", {
          errorCode: auditErrorCode(error, "COMMAND_BLOCKED")
        })
      );
      throw error;
    }

    this.activeCommands += 1;
    try {
      const result = await this.runProcess(shell, request.command, cwd, timeoutMs, signal);
      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "completed", {
          shell,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          truncated: result.truncated,
          errorCode: auditErrorCodeForResult(result)
        })
      );
      return result;
    } catch (error) {
      // A completed process with an unwritable terminal audit event must not leak
      // captured stdout/stderr through the command result or another audit event.
      if (isAuditWriteFailure(error)) {
        throw error;
      }

      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "failed", {
          shell,
          cwd,
          errorCode: auditErrorCode(error, "COMMAND_EXECUTION_FAILED")
        })
      );
      throw error;
    } finally {
      this.activeCommands -= 1;
    }
  }

  async listAuditEvents(limit: number): Promise<AuditEventList> {
    return await this.auditLog.list(limit);
  }

  private followUpAuditEvent(
    attempted: CommandAuditEvent,
    phase: "blocked" | "completed" | "failed",
    overrides: Partial<Pick<
      CommandAuditEvent,
      | "shell"
      | "cwd"
      | "exitCode"
      | "signal"
      | "durationMs"
      | "timedOut"
      | "truncated"
      | "errorCode"
    >>
  ): CommandAuditEvent {
    return createAuditEvent({
      auditId: attempted.auditId,
      phase,
      command: attempted.command,
      shell: overrides.shell ?? attempted.shell,
      cwd: overrides.cwd ?? attempted.cwd,
      executionMode: this.config.executionMode,
      source: this.auditSource(),
      exitCode: overrides.exitCode ?? null,
      signal: overrides.signal ?? null,
      durationMs: overrides.durationMs ?? null,
      timedOut: overrides.timedOut ?? false,
      truncated: overrides.truncated ?? false,
      errorCode: overrides.errorCode ?? null
    });
  }

  private auditSource(): "http-bearer" | "stdio" {
    return this.config.transport === "http" ? "http-bearer" : "stdio";
  }

  private async writeAuditEvent(event: CommandAuditEvent): Promise<void> {
    try {
      await this.auditLog.write(event);
    } catch (error) {
      if (isAuditWriteFailure(error)) {
        throw error;
      }
      throw new AppError(
        "AUDIT_LOG_WRITE_FAILED",
        "Command auditing is unavailable, so the command was not started or its result was withheld.",
        "Restore the configured audit sink before retrying the command.",
        { cause: error }
      );
    }
  }

  private runProcess(
    shell: ShellKind,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    let invocation: ShellInvocation;
    const environment = buildChildEnvironment(this.config.passthroughEnv);
    if (this.config.executionMode === "allowlist") {
      const { profile, args } = resolveSafeCommand(this.config, shell, command);
      invocation = { executable: profile.executable, args };
      if (profile.cmdlet) {
        invocation.args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../../scripts/windows/run-cmdlet.ps1", import.meta.url))];
        environment.COMMAND_BRIDGE_CMDLET_REQUEST = Buffer.from(JSON.stringify({ name: profile.cmdlet, args })).toString("base64");
      }
    } else invocation = buildShellInvocation(shell, command);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd,
        env: environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let settled = false;

      let termination: Promise<void> | undefined;
      let closeDeadline: NodeJS.Timeout | undefined;
      let cancellation = false;
      const finishFailure = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        this.stopping = true;
        reject(error);
      };
      const terminate = () => {
        if (!termination) {
          termination = terminateProcessTree(child);
          void termination.then(() => {
            if (!settled) closeDeadline = setTimeout(() => finishFailure(new AppError("COMMAND_TERMINATION_FAILED", "Command streams did not close after termination.")), 500);
          }, () => undefined);
          void termination.catch(error => finishFailure(new AppError("COMMAND_TERMINATION_FAILED", "Could not confirm command termination.", undefined, { cause: error })));
        }
      };
      const cancel = () => { cancellation = true; terminate(); };
      const cleanup = () => {
        clearTimeout(timeout);
        if (closeDeadline) clearTimeout(closeDeadline);
        this.running.delete(cancel);
        signal?.removeEventListener("abort", cancel);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      this.running.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (this.stopping || signal?.aborted) cancel();

      const appendOutput = (current: string, chunk: Buffer): string => {
        const text = chunk.toString("utf8");
        const remaining = this.config.maxOutputChars - stdout.length - stderr.length;

        if (remaining <= 0) {
          if (!truncated) {
            truncated = true;
            terminate();
          }
          return current;
        }

        if (text.length > remaining) {
          truncated = true;
          terminate();
          return current + text.slice(0, remaining);
        }

        return current + text;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk);
      });

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new AppError(
            "COMMAND_START_FAILED",
            error.message,
            "Check that the selected shell is installed and the working directory exists.",
            { cause: error }
          )
        );
      });

      child.once("close", async (exitCode, processSignal) => {
        try { await termination; }
        catch (error) { finishFailure(new AppError("COMMAND_TERMINATION_FAILED", "Could not confirm command termination.", undefined, { cause: error })); return; }
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (cancellation) { reject(new AppError("COMMAND_CANCELLED", "The command was cancelled.")); return; }
        resolve({
          ok: exitCode === 0 && !timedOut && !truncated,
          shell,
          cwd,
          exitCode,
          signal: processSignal,
          stdout,
          stderr,
          timedOut,
          truncated,
          durationMs: Date.now() - startedAt
        });
      });
    });
  }
}

function isAuditWriteFailure(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "AUDIT_LOG_WRITE_FAILED";
}

function auditErrorCode(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.code : fallback;
}

function auditErrorCodeForResult(result: CommandResult): string | null {
  if (result.timedOut) {
    return "COMMAND_TIMEOUT";
  }
  if (result.truncated) {
    return "COMMAND_OUTPUT_TRUNCATED";
  }
  if (!result.ok) {
    return "COMMAND_EXIT_NON_ZERO";
  }
  return null;
}

function buildShellInvocation(shell: ShellKind, command: string): ShellInvocation {
  switch (shell) {
    case "bash":
      return { executable: "bash", args: ["-lc", command] };
    case "sh":
      return { executable: "sh", args: ["-lc", command] };
    case "powershell":
      return {
        executable: process.platform === "win32" ? "powershell.exe" : "pwsh",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
            "$OutputEncoding = [Console]::OutputEncoding; " +
            command
        ]
      };
    case "cmd":
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
}

function buildChildEnvironment(extraKeys: string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const key of new Set([...defaultEnvironmentKeys, ...extraKeys])) {
    const sourceKey =
      process.platform === "win32"
        ? Object.keys(process.env).find(
            (environmentKey) => environmentKey.toLowerCase() === key.toLowerCase()
          )
        : key;
    const value = sourceKey ? process.env[sourceKey] : undefined;
    if (sourceKey && value !== undefined) {
      environment[sourceKey] = value;
    }
  }

  if (
    process.platform === "win32" &&
    !Object.keys(environment).some((key) => key.toLowerCase() === "pathext")
  ) {
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }

  return environment;
}

function clampTimeout(
  requestedTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
  maxTimeoutMs: number
): number {
  if (requestedTimeoutMs === undefined) {
    return defaultTimeoutMs;
  }
  return Math.min(Math.max(Math.trunc(requestedTimeoutMs), 1_000), maxTimeoutMs);
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  // A Linux group can outlive its leader while descendants still hold our pipes.
  if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    let ended = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (error?: Error) => {
      if (ended) return;
      ended = true;
      timers.forEach(clearTimeout);
      child.removeListener("close", onClose);
      error ? reject(error) : resolve();
    };
    const onClose = () => { /* Completion is confirmed by taskkill or process-group checks. */ };
    child.once("close", onClose);
    timers.push(setTimeout(() => done(new Error("Process termination deadline exceeded.")), 5_000));
    if (process.platform === "win32") {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", error => done(error));
      killer.once("close", code => {
        if (code !== 0) { done(new Error("taskkill failed.")); return; }
        if (child.exitCode !== null || child.signalCode !== null) done();
        else child.once("close", () => done());
      });
      timers.push(setTimeout(() => killer.kill(), 4_000));
    } else {
      const send = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") done(error as Error); }
      };
      send("SIGTERM");
      timers.push(setTimeout(() => send("SIGKILL"), 2_000));
      const check = () => {
        if (ended) return;
        try { process.kill(-pid, 0); timers.push(setTimeout(check, 50)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") done();
          else done(error as Error);
        }
      };
      check();
    }
  });
}
