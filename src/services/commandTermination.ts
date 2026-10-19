import type { ChildProcess } from "node:child_process";
import { AppError } from "../errors/AppError.js";
import { z } from "zod";

export type TerminationTrigger = "timeout" | "output-limit" | "client-cancel" | "service-shutdown" | "output-decode-failure";
export interface ExecutionEvidence {
  trigger: TerminationTrigger | null;
  timeoutMs: number;
  outputLimit: number;
  outputChars: number;
  outputBytes: number;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
  durationMs: number;
  stage: "requested" | "signal" | "group-check" | "deadline" | "streams" | "confirmed";
  reason: "EPERM" | "EACCES" | "ESRCH" | "deadline-exceeded" | "streams-open" | "other" | null;
}

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const executionEvidenceSchema: z.ZodType<ExecutionEvidence> = z.object({
  trigger: z.enum(["timeout", "output-limit", "client-cancel", "service-shutdown", "output-decode-failure"]).nullable(),
  timeoutMs: counter, outputLimit: counter, outputChars: counter, outputBytes: counter,
  timedOut: z.boolean(), truncated: z.boolean(), cancelled: z.boolean(), durationMs: counter,
  stage: z.enum(["requested", "signal", "group-check", "deadline", "streams", "confirmed"]),
  reason: z.enum(["EPERM", "EACCES", "ESRCH", "deadline-exceeded", "streams-open", "other"]).nullable()
}).strict();

export class CommandExecutionError extends AppError {
  constructor(code: string, message: string, readonly evidence: ExecutionEvidence, cause?: unknown) {
    super(code, message, code === "COMMAND_TERMINATION_FAILED" ?
      "Termination is unconfirmed. Its slot remains quarantined until process exit and stream closure are confirmed. An administrator may need to stop privileged descendants; inspect diagnostics and service logs." : undefined,
      { cause });
  }
}

export class ProcessTerminationError extends Error {
  constructor(readonly stage: ExecutionEvidence["stage"], readonly reason: ExecutionEvidence["reason"], cause?: unknown) {
    super(reason === "deadline-exceeded" ? "Process termination deadline exceeded." : "Process termination could not be confirmed.", { cause });
  }
}

export function processGroupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function terminationConfirmed(child: ChildProcess): boolean {
  const exited = child.exitCode !== null || child.signalCode !== null;
  const streamsClosed = child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false;
  return exited && streamsClosed && (process.platform === "win32" || !child.pid || processGroupAbsent(child.pid));
}

export class CommandQuarantine {
  private readonly entries = new Map<string, () => boolean>();
  private timer?: NodeJS.Timeout;
  get size(): number { this.refresh(); return this.entries.size; }
  hold(auditId: string, confirmed: () => boolean): void {
    this.entries.set(auditId, confirmed);
    if (!this.timer) { this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref(); }
  }
  private refresh(): void {
    for (const [auditId, confirmed] of this.entries) {
      if (confirmed()) {
        this.entries.delete(auditId);
        console.error(JSON.stringify({ event: "command_bridge.termination_recovered", auditId }));
      }
    }
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
