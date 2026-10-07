import type { AuditLog, AuditEventList, CommandAuditEvent } from "./auditLog.js";
import { AppError } from "../errors/AppError.js";

/** A response deadline is not cancellation of an underlying filesystem operation. */
export class BoundedAuditLog implements AuditLog {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private unavailable = false;
  constructor(private readonly backend: AuditLog, private readonly deadlineMs = 5_000) {}

  get available(): boolean { return !this.unavailable; }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }
  write(event: CommandAuditEvent): Promise<void> {
    return this.run("AUDIT_LOG_WRITE_FAILED", () => this.backend.write(event));
  }
  list(limit: number): Promise<AuditEventList> {
    return this.run("AUDIT_LOG_READ_FAILED", () => this.backend.list(limit));
  }
  private async run<T>(code: string, action: () => Promise<T>): Promise<T> {
    const failure = (cause?: unknown) => new AppError(code,
      "Audit is unavailable; the operation was not started or its result was withheld.",
      "Inspect host storage and restart the service after resolving the Audit failure. A timed-out write may still finish.",
      { cause });
    if (this.unavailable) throw failure();
    // Bound callers even before the first deadline expires.
    if (this.pending.size >= 64) { this.unavailable = true; throw failure(); }
    const operation = this.queue.then(() => {
      // An expired queued operation must never start a late backend write.
      if (this.unavailable) throw failure();
      return action();
    });
    this.queue = operation.catch(() => { this.unavailable = true; });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.unavailable = true;
          reject(new Error("Audit operation timed out."));
        }, this.deadlineMs);
      })]);
    } catch (cause) {
      this.unavailable = true;
      throw failure(cause);
    } finally { if (timer) clearTimeout(timer); }
  }
}
