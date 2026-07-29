import { spawn, type ChildProcess } from "node:child_process";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import {
  assertCommandAllowed,
  resolveWorkingDirectory,
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

  constructor(
    private readonly config: AppConfig,
    private readonly auditLog: AuditLog = createAuditLog(config)
  ) {}

  async execute(request: CommandRequest): Promise<CommandResult> {
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
      const result = await this.runProcess(shell, request.command, cwd, timeoutMs);
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
    timeoutMs: number
  ): Promise<CommandResult> {
    const invocation = buildShellInvocation(shell, command);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd,
        env: buildChildEnvironment(this.config.passthroughEnv),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let settled = false;

      const terminate = () => terminateProcessTree(child);
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);

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
        clearTimeout(timeout);
        reject(
          new AppError(
            "COMMAND_START_FAILED",
            error.message,
            "Check that the selected shell is installed and the working directory exists.",
            { cause: error }
          )
        );
      });

      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: exitCode === 0 && !timedOut && !truncated,
          shell,
          cwd,
          exitCode,
          signal,
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

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    }).unref();
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
