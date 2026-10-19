import { spawn, type ChildProcess } from "node:child_process";
import { access, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { CommandExecutionError, CommandQuarantine, ProcessTerminationError, terminationConfirmed, type ExecutionEvidence } from "./commandTermination.js";
import { ManagedUpdateService } from "./managedUpdate.js";
import { BackgroundJobService, type BackgroundExecution } from "./backgroundJobs.js";
import { FileTransferService } from "./fileTransferService.js";
import { DiagnosticsService } from "./diagnosticsService.js";
import { RecentDiagnosticRequests, type RecentDiagnosticRequest } from "./diagnosticTypes.js";
import { BoundedAuditLog } from "./boundedAuditLog.js";
import { auditTimeout, auditRequestTimeout } from "../config/auditTimeout.js";
import { assertNoSelfModification, assertNoLocalAdminCommand } from "./selfProtection.js";
import { assertGuardedCommand } from "./guardedPolicy.js";
import type { TemporaryAccess } from "./temporaryAccess.js";
import { assertOutputEncoding, createOutputDecoder, outputDecodingError, type OutputEncoding } from "./textEncoding.js";
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
  outputEncoding?: OutputEncoding;
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
  windowsVerbatimArguments?: boolean;
}

const defaultEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "WINDIR"
];

export class CommandExecutor {
  readonly diagnostics: DiagnosticsService;
  private readonly recentDiagnostics = new RecentDiagnosticRequests();
  private readonly diagnosticStartTimes = new WeakMap<CommandAuditEvent, string>();
  readonly files: FileTransferService;
  readonly updates: ManagedUpdateService;
  readonly jobs: BackgroundJobService;
  private activeCommands = 0;
  private reservedCommands = 0;
  private stopping = false;
  private readonly quarantine = new CommandQuarantine();
  private readonly running = new Set<() => void>();
  private readonly pending = new Set<Promise<CommandResult>>();
  private readonly auditLog: BoundedAuditLog;
  private readinessDependencies?:Record<string,boolean>;
  private pendingReadiness?: Promise<{ ready: boolean; checks: Record<string, boolean> }>;

  constructor(
    private readonly config: AppConfig,
    auditLog: AuditLog = createAuditLog(config)
  ) {
    this.auditLog = auditLog instanceof BoundedAuditLog ? auditLog : new BoundedAuditLog(auditLog, auditTimeout(config));
    this.diagnostics = new DiagnosticsService(config, this.auditLog, () => ({
      accepting: this.acceptingCommands && this.quarantine.size < this.config.maxParallelCommands,
      mode: this.stopping ? "stopping" : !this.auditLog.available ? "diagnostic-only" : this.quarantine.size ? "degraded" : "normal",
      quarantinedCommands: this.quarantine.size,
      activeCommands: this.activeCommands, maxParallelCommands: this.config.maxParallelCommands,
      backgroundJobs: this.jobs?.snapshot() ?? { enabled: false, storageAvailable: true, queued: 0, active: 0 },
      recentRequests: this.recentDiagnostics.list(undefined,100)
    }));
    this.files = new FileTransferService(config, this.auditLog);
    this.jobs = new BackgroundJobService(config, this);
    this.updates = new ManagedUpdateService(config, this.auditLog, undefined, () => this.jobs.hasActive() || this.quarantine.size > 0);
  }

  private temporaryAccess?: TemporaryAccess;
  enableTemporaryAccess(control: TemporaryAccess) { this.temporaryAccess = control; }
  async effectiveExecutionMode() { return this.temporaryAccess ? this.temporaryAccess.refresh() : this.config.executionMode; }
  async accessStatus() { if (!this.temporaryAccess) return null; await this.temporaryAccess.refresh(); return this.temporaryAccess.status(); }
  async auditAccess(action: string) {
    const attempted = createAuditEvent({ phase: "attempted", command: "CommandBridge temporary access " + action, executionMode: this.config.executionMode, source: this.auditSource() });
    await this.writeAuditEvent(attempted);
    await this.writeAuditEvent(this.followUpAuditEvent(attempted, "completed", {}));
  }

  execute(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const operation = this.executeInternal(request, signal);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const jobShutdown = this.jobs.shutdown();
    const fileShutdown = this.files.shutdown();
    const updateShutdown = this.updates.shutdown();
    const accessShutdown = this.temporaryAccess?.stop();
    this.diagnostics.stop();
    this.updates.stop();
    for (const stop of this.running) stop();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending, jobShutdown, fileShutdown, updateShutdown, accessShutdown, this.diagnostics.drain(), ...(this.pendingReadiness ? [this.pendingReadiness] : [])]).then(() => this.auditLog.drain()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded.")), 15_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); this.quarantine.stop(); }
  }

  private completedReadiness?: { at: number; value: { ready: boolean; checks: Record<string, boolean> } };
  async readiness(waitMs = 5_000): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    if (this.quarantine.size) return { ready: false, checks: { accepting: this.acceptingCommands && this.availableCommandSlots > 0, audit: this.auditLog.available, terminationConfirmed: false } };
    if (this.stopping || !this.auditLog.available) return { ready: false, checks: { accepting: false, audit: this.auditLog.available } };
    if (this.config.jobs?.enabled && !this.jobs.snapshot().storageAvailable) return { ready: false, checks: { accepting: true, audit: true, backgroundJobs: false } };
    if (this.completedReadiness && performance.now() - this.completedReadiness.at < 2000) return this.completedReadiness.value;
    // Repeated probes share the actual operation if a filesystem call remains stuck.
    if (!this.pendingReadiness) {
      const operation = this.readinessInternal().then(value => { this.completedReadiness = { at: performance.now(), value }; return value; });
      this.pendingReadiness = operation;
      void operation.finally(() => { if (this.pendingReadiness === operation) this.pendingReadiness = undefined; }).catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.pendingReadiness, new Promise<{ ready: boolean; checks: Record<string, boolean> }>(resolve => {
        timer = setTimeout(() => {
          resolve({ ready:false, checks:{...this.readinessDependencies,accepting:!this.stopping && this.auditLog.available,audit:false,verification:false} });
        }, waitMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  startupReadiness() { return this.readiness(auditRequestTimeout(auditTimeout(this.config))); }

  private async readinessInternal(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    this.readinessDependencies=undefined;
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
    this.readinessDependencies={...checks};
    try {
      await this.auditLog.write(createAuditEvent({ command: "CommandBridge readiness verification", phase: "completed", executionMode: this.config.executionMode, source: this.auditSource() }));
      await this.auditLog.list(1);
    } catch (error) {
      checks.audit = false;
      if (error instanceof AppError && ["AUDIT_LOG_WRITE_FAILED", "AUDIT_LOG_READ_FAILED"].includes(error.code)) {
        const timeout = error.cause instanceof Error && error.cause.message === "Audit helper timed out.";
        console.error("CommandBridge readiness audit failure: " + error.code + (timeout ? " (helper timeout)" : ""));
      }
    }
    checks.accepting = !this.stopping && this.auditLog.available;
    return { ready: Object.values(checks).every(Boolean), checks };
  }

  get availableCommandSlots(): number { return this.stopping || !this.auditLog.available ? 0 : this.config.maxParallelCommands - this.activeCommands - this.reservedCommands - this.quarantine.size; }
  reserveJobSlot(): (() => void) | undefined {
    if (this.availableCommandSlots <= 0) return undefined;
    this.reservedCommands++;
    let released = false;
    return () => { if (!released) { released = true; this.reservedCommands--; } };
  }
  get acceptingCommands(): boolean { return !this.stopping && this.auditLog.available; }
  get backgroundUpdatePending(): boolean { return this.updates.busy; }
  validateJob(request: CommandRequest, executionMode: AppConfig["executionMode"]): void {
    const shell = request.shell ?? this.config.allowedShells[0];
    if (!shell) throw new AppError("NO_SHELL_CONFIGURED", "No shell is configured.");
    assertOutputEncoding(request.outputEncoding ?? "utf8");
    assertNoLocalAdminCommand(request.command, process.platform, request.cwd ?? this.config.allowedRoots[0] ?? process.cwd());
    assertCommandAllowed({ ...this.config, executionMode }, shell, request.command);
    const cwd = resolveWorkingDirectory(this.config.allowedRoots, request.cwd);
    assertNoSelfModification(request.command, cwd, { policyFile: this.config.policyFile, additionalProtectedPaths: this.config.jobs?.root ? [this.config.jobs.root] : [] });
    if (executionMode === "guarded") assertGuardedCommand(request.command, cwd);
  }
  writeJobAudit(event: CommandAuditEvent): Promise<void> { return this.writeAuditEvent(event); }
  executeJob(request: CommandRequest, signal: AbortSignal, background: BackgroundExecution): Promise<CommandResult> {
    const operation = this.executeInternal(request, signal, background);
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async executeInternal(request: CommandRequest, signal?: AbortSignal, background?: BackgroundExecution): Promise<CommandResult> {
    let executionMode = await this.effectiveExecutionMode();
    const requestedShell = request.shell ?? this.config.allowedShells[0] ?? null;
    const requestedCwd = request.cwd ?? this.config.allowedRoots[0] ?? null;
    const attempted = background?.attempted ?? createAuditEvent({
      phase: "attempted",
      command: request.command,
      shell: requestedShell,
      cwd: requestedCwd,
      executionMode,
      source: this.auditSource()
    });

    // This is intentionally before policy checks and before spawn. Without the attempt
    // record, CommandBridge must not start a process.
    if (!background) await this.writeAuditEvent(attempted);

    let shell: ShellKind;
    let cwd: string;
    let timeoutMs: number;

    try {
      background?.releaseSlot();
      if (this.stopping || signal?.aborted) throw new AppError("COMMAND_CANCELLED", "The command was cancelled or the service is stopping.");
      if (this.availableCommandSlots <= 0) {
        if (this.quarantine.size) throw new AppError("COMMAND_TERMINATION_UNCONFIRMED", "Capacity is reserved for commands whose termination is unconfirmed.", "Inspect diagnostics and service logs; an administrator may need to stop privileged descendants. Capacity recovers after exit and stream closure are confirmed.");
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
      assertOutputEncoding(request.outputEncoding ?? "utf8");
      assertNoLocalAdminCommand(request.command, process.platform, requestedCwd ?? process.cwd());
      // Audit admission may consume the remaining lease; recheck before policy/spawn.
      executionMode = this.temporaryAccess?.mode() ?? this.config.executionMode;
      if (background && executionMode !== background.mode) throw new AppError("JOB_POLICY_CHANGED", "Execution mode changed while queued; submit a new job.");
      assertCommandAllowed({ ...this.config, executionMode }, shell, request.command);
      cwd = resolveWorkingDirectory(this.config.allowedRoots, request.cwd);
      assertNoSelfModification(request.command, cwd, { policyFile: this.config.policyFile, additionalProtectedPaths: this.config.jobs?.root ? [this.config.jobs.root] : [] });
      if (executionMode === "guarded") assertGuardedCommand(request.command, cwd);
      timeoutMs = background ? request.timeoutMs! : clampTimeout(
        request.timeoutMs,
        this.config.defaultTimeoutMs,
        this.config.maxTimeoutMs
      );
    } catch (error) {
      if (error instanceof AppError && error.rule) error.auditId = attempted.auditId;
      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "blocked", {
          executionMode,
          errorCode: auditErrorCode(error, "COMMAND_BLOCKED")
        })
      );
      throw error;
    }

    this.recordDiagnostic(attempted,"running");
    this.activeCommands += 1;
    try {
      let result: CommandResult;
      try { result = await this.runProcess(shell, request.command, cwd, timeoutMs, signal, request.outputEncoding ?? "utf8", executionMode, background, attempted.auditId); }
      finally { this.activeCommands -= 1; }
      background?.finalizing();
      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "completed", {
          executionMode,
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

      if (error instanceof CommandExecutionError) {
        this.executionEvidence.set(attempted.auditId, error.evidence);
        while (this.executionEvidence.size > 100) this.executionEvidence.delete(this.executionEvidence.keys().next().value!);
        console.error(JSON.stringify({ event: "command_bridge.execution_failure", auditId: attempted.auditId, ...(attempted.job ? { jobId: attempted.job.jobId } : {}), code: error.code, ...error.evidence }));
      }
      await this.writeAuditEvent(
        this.followUpAuditEvent(attempted, "failed", {
          executionMode,
          shell,
          cwd,
          ...(error instanceof CommandExecutionError ? { timedOut: error.evidence.timedOut, truncated: error.evidence.truncated, durationMs: error.evidence.durationMs } : {}),
          errorCode: auditErrorCode(error, "COMMAND_EXECUTION_FAILED")
        })
      );
      throw error;
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
      | "executionMode"
    >>
  ): CommandAuditEvent {
    const event = createAuditEvent({
      auditId: attempted.auditId,
      phase,
      command: attempted.command,
      shell: overrides.shell ?? attempted.shell,
      cwd: overrides.cwd ?? attempted.cwd,
      executionMode: overrides.executionMode ?? attempted.executionMode,
      source: this.auditSource(),
      exitCode: overrides.exitCode ?? null,
      signal: overrides.signal ?? null,
      durationMs: overrides.durationMs ?? null,
      timedOut: overrides.timedOut ?? false,
      truncated: overrides.truncated ?? false,
      errorCode: overrides.errorCode ?? null
      , ...(attempted.job ? { job: attempted.job } : {})
    });
    this.diagnosticStartTimes.set(event, attempted.timestamp);
    return event;
  }

  private auditSource(): "http-bearer" | "stdio" {
    return this.config.transport === "http" ? "http-bearer" : "stdio";
  }

  private readonly executionEvidence = new Map<string, ExecutionEvidence>();
  private recordDiagnostic(event: CommandAuditEvent, phase: RecentDiagnosticRequest["phase"] = event.phase, errorCode = event.errorCode): void {
    this.recentDiagnostics.record({ auditId:event.auditId, startedAt:this.diagnosticStartTimes.get(event) ?? this.recentDiagnostics.list(event.auditId,1)[0]?.startedAt ?? event.timestamp, phase, durationMs:event.durationMs, exitCode:event.exitCode, timedOut:event.timedOut, errorCode, ...(this.executionEvidence.has(event.auditId) ? { execution: this.executionEvidence.get(event.auditId) } : {}) });
  }

  private async writeAuditEvent(event: CommandAuditEvent): Promise<void> {
    if(event.phase === "attempted") this.recordDiagnostic(event);
    try {
      await this.auditLog.write(event);
      this.recordDiagnostic(event);
    } catch (error) {
      this.recordDiagnostic(event,"auditUnavailable","AUDIT_LOG_WRITE_FAILED");
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
    signal?: AbortSignal,
    outputEncoding: OutputEncoding = "utf8",
    executionMode = this.config.executionMode,
    background?: BackgroundExecution,
    auditId: string = randomUUID()
  ): Promise<CommandResult> {
    let invocation: ShellInvocation;
    const environment = buildChildEnvironment(this.config.passthroughEnv);
    if (executionMode === "allowlist") {
      const { profile, args } = resolveSafeCommand(this.config, shell, command);
      invocation = { executable: profile.executable, args };
      if (profile.cmdlet) {
        // Keep Windows PowerShell discovery independent of the parent's PowerShell
        // edition, user-installed modules and caller passthrough settings.
        for (const key of Object.keys(environment)) {
          if (key.toLowerCase() === "psmodulepath") delete environment[key];
        }
        environment.PSModulePath = join(dirname(profile.executable), "Modules");
        invocation.args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../../scripts/windows/run-cmdlet.ps1", import.meta.url))];
        environment.COMMAND_BRIDGE_CMDLET_REQUEST = Buffer.from(JSON.stringify({ name: profile.cmdlet, args })).toString("base64");
      }
    } else {
      invocation = buildShellInvocation(shell, command);
      if (shell === "cmd" && process.platform === "win32") {
        environment.COMMAND_BRIDGE_CMD_REQUEST = command;
        for (const key of Object.keys(environment)) if (key.toLowerCase() === "psmodulepath") delete environment[key];
        environment.PSModulePath = join(dirname(invocation.executable), "Modules");
      }
      if (shell === "powershell" && process.platform === "win32") {
        // Keep Unicode/long source out of Windows native command-line quoting.
        // Clear reserved keys case-insensitively before setting our own values.
        for (const key of Object.keys(environment)) {
          if (["command_bridge_powershell_request", "command_bridge_powershell_builtins"].includes(key.toLowerCase())) delete environment[key];
        }
        if (!Object.keys(environment).some(key => key.toLowerCase() === "psmodulepath")) {
          environment.PSModulePath = join(dirname(invocation.executable), "Modules");
          environment.COMMAND_BRIDGE_POWERSHELL_BUILTINS = "1";
        }
        environment.COMMAND_BRIDGE_POWERSHELL_REQUEST = command;
      }
    }
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd,
        env: environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      const stdoutDecoder = createOutputDecoder(outputEncoding);
      const stderrDecoder = createOutputDecoder(outputEncoding);
      let outputFailure: AppError | undefined;
      let timedOut = false;
      let truncated = false;
      let settled = false;

      let termination: Promise<void> | undefined;
      let closeDeadline: NodeJS.Timeout | undefined;
      let cancellation = false;
      let storedOutputBytes = 0;
      let outputBytes = 0;
      let outputChars = 0;
      let trigger: ExecutionEvidence["trigger"] = null;
      const evidence = (error?: unknown): ExecutionEvidence => ({
        trigger, timeoutMs, outputLimit: background ? 5 * 1024 * 1024 : this.config.maxOutputChars,
        outputChars, outputBytes, timedOut, truncated, cancelled: cancellation, durationMs: Math.max(0, Date.now() - startedAt),
        stage: error instanceof ProcessTerminationError ? error.stage : "confirmed",
        reason: error instanceof ProcessTerminationError ? error.reason : null
      });
      const finishFailure = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!terminationConfirmed(child)) this.quarantine.hold(auditId, () => terminationConfirmed(child));
        child.unref();
        reject(new CommandExecutionError(error instanceof AppError ? error.code : "COMMAND_TERMINATION_FAILED", error.message, evidence(error.cause ?? error), error));
      };
      const terminate = (reason: NonNullable<ExecutionEvidence["trigger"]>) => {
        trigger ??= reason;
        if (!termination) {
          console.error(JSON.stringify({ event: "command_bridge.termination_requested", auditId, ...evidence(), stage: "requested" }));
          termination = terminateProcessTree(child);
          void termination.then(() => {
            if (!settled) closeDeadline = setTimeout(() => finishFailure(new AppError("COMMAND_TERMINATION_FAILED", "Command streams did not close after termination.", undefined, { cause: new ProcessTerminationError("streams", "streams-open") })), 500);
          }, () => undefined);
          void termination.catch(error => finishFailure(new AppError("COMMAND_TERMINATION_FAILED", "Could not confirm command termination.", undefined, { cause: error })));
        }
      };
      const cancel = () => { cancellation = true; terminate(this.stopping ? "service-shutdown" : "client-cancel"); };
      const cleanup = () => {
        clearTimeout(timeout);
        if (closeDeadline) clearTimeout(closeDeadline);
        this.running.delete(cancel);
        signal?.removeEventListener("abort", cancel);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate("timeout");
      }, timeoutMs);
      this.running.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (this.stopping || signal?.aborted) cancel();

      const appendOutput = (current: string, text: string): string => {
        if (!text) return current;
        outputChars = Math.min(Number.MAX_SAFE_INTEGER, outputChars + text.length);
        if (background) {
          const remainingBytes = 10 * 1024 * 1024 - storedOutputBytes;
          const remainingChars = 5 * 1024 * 1024 - stdout.length - stderr.length;
          let prefix = text.slice(0, Math.max(0, remainingChars));
          if (prefix.length < text.length) { truncated = true; prefix = prefix.replace(/[\uD800-\uDBFF]$/, ""); }
          const size = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
          if (size(prefix) > remainingBytes) {
            truncated = true;
            let lo = 0, hi = prefix.length;
            while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (size(prefix.slice(0, mid)) <= remainingBytes) lo = mid; else hi = mid - 1; }
            prefix = prefix.slice(0, lo).replace(/[\uD800-\uDBFF]$/, "");
          }
          storedOutputBytes += size(prefix);
          return current + prefix;
        }
        const remaining = (background ? 5 * 1024 * 1024 : this.config.maxOutputChars) - stdout.length - stderr.length;

        if (remaining <= 0) {
          if (!truncated) {
            truncated = true;
            if (!background) terminate("output-limit");
          }
          return current;
        }

        if (text.length > remaining) {
          truncated = true;
          if (!background) terminate("output-limit");
          const prefix = text.slice(0, remaining);
          // Do not return half of a UTF-16 surrogate pair at the character cap.
          return current + prefix.replace(/[\uD800-\uDBFF]$/, "");
        }

        return current + text;
      };

      const decode = (decoder: TextDecoder, chunk?: Buffer) => {
        if (outputFailure || settled || (chunk === undefined && (timedOut || truncated || cancellation))) return "";
        try { return decoder.decode(chunk, { stream: chunk !== undefined }); }
        catch {
          trigger ??= "output-decode-failure";
          outputFailure = outputDecodingError();
          // EOF can precede the process close callback. An incomplete final
          // character needs no additional taskkill; the normal deadline still
          // bounds a process that closes its pipes without exiting.
          if (chunk !== undefined) terminate("output-decode-failure");
          return "";
        }
      };
      child.stdout.on("data", (chunk: Buffer) => { outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.length); stdout = appendOutput(stdout, decode(stdoutDecoder, chunk)); if (!settled) background?.activity(chunk.length, truncated); });
      child.stderr.on("data", (chunk: Buffer) => { outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.length); stderr = appendOutput(stderr, decode(stderrDecoder, chunk)); if (!settled) background?.activity(chunk.length, truncated); });
      child.stdout.once("end", () => { stdout = appendOutput(stdout, decode(stdoutDecoder)); });
      child.stderr.once("end", () => { stderr = appendOutput(stderr, decode(stderrDecoder)); });

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
        if (cancellation) { reject(new CommandExecutionError("COMMAND_CANCELLED", "The command was cancelled.", evidence())); return; }
        if (outputFailure) { reject(new CommandExecutionError(outputFailure.code, outputFailure.message, evidence(), outputFailure)); return; }
        if (trigger) {
          this.executionEvidence.set(auditId, evidence());
          while (this.executionEvidence.size > 100) this.executionEvidence.delete(this.executionEvidence.keys().next().value!);
        }
        resolve({
          ok: exitCode === 0 && !timedOut && (!truncated || !!background),
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
        executable: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : "pwsh",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
            "[Console]::InputEncoding = [Console]::OutputEncoding; " +
            "$OutputEncoding = [Console]::OutputEncoding; " +
            (process.platform === "win32" ?
              "$commandBridgeSource = [Environment]::GetEnvironmentVariable('COMMAND_BRIDGE_POWERSHELL_REQUEST'); " +
              "[Environment]::SetEnvironmentVariable('COMMAND_BRIDGE_POWERSHELL_REQUEST',$null); " +
              "if ([Environment]::GetEnvironmentVariable('COMMAND_BRIDGE_POWERSHELL_BUILTINS') -eq '1') { " +
              "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop; " +
              "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop }; " +
              "[Environment]::SetEnvironmentVariable('COMMAND_BRIDGE_POWERSHELL_BUILTINS',$null); " +
              ". ([scriptblock]::Create($commandBridgeSource))" : command)
        ]
      };
    case "cmd":
      if (process.platform === "win32") return {
        executable: join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../../scripts/windows/run-cmd.ps1", import.meta.url))]
      };
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] };
  }
}

export function buildChildEnvironment(extraKeys: string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  const windowsKeys = process.platform === "win32" ? [
    "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH"
  ] : [];
  for (const key of new Set([...defaultEnvironmentKeys, ...windowsKeys, ...extraKeys])) {
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
  const processAndPipesClosed = () => (child.exitCode !== null || child.signalCode !== null) &&
    child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false;
  if (process.platform === "win32" && processAndPipesClosed()) return;
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    let ended = false;
    let windowsToolFinished = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (error?: Error) => {
      if (ended) return;
      ended = true;
      timers.forEach(clearTimeout);
      child.removeListener("close", onClose);
      error ? reject(error) : resolve();
    };
    const onClose = () => {
      if (process.platform === "win32" && windowsToolFinished && processAndPipesClosed()) done();
    };
    child.once("close", onClose);
    timers.push(setTimeout(() => done(new ProcessTerminationError("deadline", "deadline-exceeded")), 5_000));
    if (process.platform === "win32") {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", error => done(new ProcessTerminationError("signal", "other", error)));
      killer.once("close", () => {
        windowsToolFinished = true;
        // taskkill may finish before Node observes a natural exit. Wait within
        // the existing deadline for exit AND both pipes, even for a nonzero
        // tool status. Live or orphaned pipes must still fail at that deadline.
        if (processAndPipesClosed()) done();
      });
      timers.push(setTimeout(() => killer.kill(), 4_000));
    } else {
      const send = (signal: NodeJS.Signals) => {
        if (ended) return;
        try { process.kill(-pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") done(new ProcessTerminationError("signal", ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code as "EPERM" | "EACCES" : "other", error)); }
      };
      send("SIGTERM");
      if (ended) return;
      timers.push(setTimeout(() => send("SIGKILL"), 2_000));
      const check = () => {
        if (ended) return;
        try { process.kill(-pid, 0); timers.push(setTimeout(check, 50)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") done();
          else done(new ProcessTerminationError("group-check", ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code as "EPERM" | "EACCES" : "other", error));
        }
      };
      check();
    }
  });
}
