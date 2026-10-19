import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { createAuditEvent, type CommandAuditEvent } from "./auditLog.js";
import type { CommandExecutor, CommandRequest, CommandResult } from "./commandExecutor.js";
import { JobStore } from "./jobStore.js";
import { CommandExecutionError, executionEvidenceSchema } from "./commandTermination.js";

export interface BackgroundExecution {
  attempted: CommandAuditEvent;
  mode: AppConfig["executionMode"];
  activity(bytes: number, truncated: boolean): void;
  finalizing(): void;
  releaseSlot(): void;
}
export const jobRequestSchema = z.object({
  requestId: z.string().uuid(), command: z.string().min(1).max(20000),
  shell: z.enum(["bash", "sh", "powershell", "cmd"]).optional(),
  cwd: z.string().min(1).max(4096).optional(), timeoutMs: z.number().int().min(1000).max(86400000).optional(),
  outputEncoding: z.enum(["utf8", "utf16le", "big5", "gbk", "gb18030"]).optional()
}).strict();
type JobRequest = z.infer<typeof jobRequestSchema>;
const states = ["queued", "starting", "running", "finalizing", "completed", "failed", "cancelled", "timed_out", "interrupted"] as const;
const recordSchema = z.object({
  execution: executionEvidenceSchema.optional(),
  schemaVersion: z.literal(1), jobId: z.string().uuid(), requestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), binding: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(states), mode: z.enum(["allowlist", "guarded", "unrestricted"]),
  createdAt: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative().nullable(), endedAt: z.number().int().nonnegative().nullable(),
  auditId: z.string().uuid(), auditStatus: z.enum(["pending", "confirmed", "unavailable", "unknown"]),
  errorCode: z.string().max(100).nullable(), terminationStatus: z.enum(["not_requested", "requested", "confirmed", "unknown"]),
  outputBytes: z.number().int().nonnegative().default(0),
  result: z.object({ ok: z.boolean(), shell: z.enum(["bash", "sh", "powershell", "cmd"]), cwd: z.string().max(4096), exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string().max(5242880), stderr: z.string().max(5242880), timedOut: z.boolean(), truncated: z.boolean(), durationMs: z.number().nonnegative() }).strict().nullable()
}).strict();
type Record = z.infer<typeof recordSchema>;
interface Active { request: CommandRequest; event: CommandAuditEvent; controller: AbortController; queuedAt: number; activityAt: number | null; truncated: boolean; operation?: Promise<void> }
const live = (record: Record) => ["queued", "starting", "running", "finalizing"].includes(record.state);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class BackgroundJobService {
  private readonly records = new Map<string, Record>();
  private readonly active = new Map<string, Active>();
  private readonly submissions = new Map<string, { fingerprint: string; operation: Promise<ReturnType<BackgroundJobService["summary"]>> }>();
  private readonly store?: JobStore;
  private initialization?: Promise<void>;
  private stopping = false;
  private fault = false;
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private cleanupAt = performance.now();
  private readonly binding: string;
  constructor(private readonly config: AppConfig, private readonly executor: CommandExecutor) {
    const root = process.platform === "linux" && config.jobs?.root === "/var/lib/command-bridge-jobs" ? join(config.jobs.root, String(process.getuid!())) : config.jobs?.root;
    this.store = root ? new JobStore(root) : undefined;
    this.binding = hash(JSON.stringify([config.transport, config.bearerToken ?? process.getuid?.() ?? "stdio", root]));
  }
  hasActive(): boolean { return this.submissions.size > 0 || this.active.size > 0 || [...this.records.values()].some(live); }
  snapshot() { return { enabled: this.config.jobs?.enabled ?? false, storageAvailable: !this.fault, queued: [...this.records.values()].filter(r => r.state === "queued").length, active: [...this.records.values()].filter(r => ["starting", "running", "finalizing"].includes(r.state)).length }; }
  private fail(): void { this.fault = true; for (const active of this.active.values()) if (active.operation) active.controller.abort(); }
  private assertEnabled(): void {
    if (!this.config.jobs?.enabled || !this.store) throw new AppError("JOBS_DISABLED", "Background jobs are disabled; a host administrator must enable and provision job storage.");
    if (this.fault) throw new AppError("JOB_STORAGE_UNAVAILABLE", "Background job storage is unavailable; inspect the host and restart.");
  }
  initialize(): Promise<void> {
    if (!this.config.jobs?.enabled) return Promise.resolve();
    this.assertEnabled();
    if (!this.initialization) {
      this.initialization = this.store!.operation(async () => {
        await this.store!.acquire(this.binding);
        for (const id of await this.store!.files()) {
          const item = recordSchema.parse(JSON.parse(await this.store!.read(id)));
          if (item.jobId !== id || item.binding !== this.binding || [...this.records.values()].some(r => r.requestId === item.requestId)) throw new Error("Job record identity mismatch.");
          if (live(item)) {
            item.state = "interrupted"; item.endedAt = Date.now(); item.result = null;
            item.auditStatus = "unknown"; item.terminationStatus = "unknown"; item.errorCode = "JOB_SERVICE_INTERRUPTED";
            await this.store!.save(id, item);
          }
          this.records.set(id, item);
        }
        await this.cleanup();
      }).then(() => {
        if (!this.stopping && !this.timer) { this.timer = setInterval(() => { void this.pump().catch(() => this.fail()); }, 250); this.timer.unref(); }
      }).catch(error => { this.fail(); throw error; });
    }
    return this.initialization;
  }
  private async cleanup(): Promise<void> {
    for (const [id, record] of this.records) {
      if (!live(record) && record.endedAt !== null && Date.now() - record.endedAt >= 86400000) {
        await this.store!.remove(id); this.records.delete(id);
      }
    }
  }
  private summary(record: Record) {
    const publishing = this.active.get(record.jobId)?.operation && !live(record);
    return { schemaVersion: 1 as const, jobId: record.jobId, requestId: record.requestId, state: publishing ? "finalizing" as const : record.state, executionMode: record.mode,
      createdAt: new Date(record.createdAt).toISOString(), startedAt: record.startedAt === null ? null : new Date(record.startedAt).toISOString(),
      endedAt: record.endedAt === null ? null : new Date(record.endedAt).toISOString(), auditId: record.auditId, auditStatus: record.auditStatus,
      outputAvailable: !publishing && record.auditStatus === "confirmed" && record.result !== null,
      exitCode: record.result?.exitCode ?? null, timedOut: record.result?.timedOut ?? record.execution?.timedOut ?? false, truncated: record.result?.truncated ?? record.execution?.truncated ?? this.active.get(record.jobId)?.truncated ?? false, outputBytes: record.outputBytes,
      ...(record.execution ? { execution: record.execution } : {}),
      terminationStatus: record.terminationStatus, errorCode: record.errorCode,
      durationMs: record.result?.durationMs ?? record.execution?.durationMs ?? (record.startedAt === null ? 0 : Math.max(0, (record.endedAt ?? Date.now()) - record.startedAt)),
      lastActivityAt: this.active.get(record.jobId)?.activityAt ?? null };
  }
  start(input: JobRequest, signal?: AbortSignal) {
    const request = jobRequestSchema.parse(input);
    request.requestId = request.requestId.toLowerCase();
    const normalized = { command: request.command, shell: request.shell ?? this.config.allowedShells[0], cwd: request.cwd ?? this.config.allowedRoots[0], timeoutMs: request.timeoutMs ?? this.config.jobs?.defaultTimeoutMs ?? 1800000, outputEncoding: request.outputEncoding ?? "utf8" };
    const fingerprint = hash(JSON.stringify(normalized));
    const pending = this.submissions.get(request.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new AppError("JOB_REQUEST_CONFLICT", "This request ID was already used with different arguments."));
      return pending.operation;
    }
    const operation = this.startInternal(request.requestId, normalized, fingerprint, signal);
    this.submissions.set(request.requestId, { fingerprint, operation });
    void operation.finally(() => this.submissions.delete(request.requestId)).catch(() => undefined);
    return operation;
  }
  private async startInternal(requestId: string, request: CommandRequest, fingerprint: string, signal?: AbortSignal) {
    this.assertEnabled(); await this.initialize();
    const previous = [...this.records.values()].find(record => record.requestId === requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError("JOB_REQUEST_CONFLICT", "This request ID was already used with different arguments.");
      return this.summary(previous);
    }
    const jobId = randomUUID(), mode = await this.executor.effectiveExecutionMode();
    const event = createAuditEvent({ phase: "attempted", command: request.command, shell: request.shell, cwd: request.cwd,
      executionMode: mode, source: this.config.transport === "http" ? "http-bearer" : "stdio", job: { schemaVersion: 1, jobId } });
    await this.executor.writeJobAudit(event);
    try {
      if (this.stopping || signal?.aborted || !this.executor.acceptingCommands) throw new AppError("JOB_CANCELLED", "The submission was cancelled or the service is stopping.");
      if (this.executor.backgroundUpdatePending) throw new AppError("JOB_UPDATE_PENDING", "Background admission is paused during a managed update; reconnect and inspect update status.");
      if (request.timeoutMs! > this.config.jobs!.maxTimeoutMs) throw new AppError("JOB_TIMEOUT_INVALID", "Requested timeout exceeds the configured background job maximum.");
      if (await this.executor.effectiveExecutionMode() !== mode) throw new AppError("JOB_POLICY_CHANGED", "Execution mode changed during admission; submit a new job.");
      this.executor.validateJob(request, mode);
      const used = [...this.records.values()].reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
      if (this.active.size >= 10 || this.records.size >= 100 || used + (this.active.size + 1) * 11 * 1024 * 1024 > 100 * 1024 * 1024) throw new AppError("JOB_QUEUE_FULL", "Background job capacity is full; wait for cleanup or existing jobs to finish.");
    } catch (error) {
      if (error instanceof AppError) error.auditId = event.auditId;
      await this.executor.writeJobAudit({ ...event, phase: "blocked", timestamp: new Date().toISOString(), errorCode: error instanceof AppError ? error.code : "JOB_BLOCKED" });
      throw error;
    }
    const record: Record = { schemaVersion: 1, jobId, requestId, fingerprint, binding: this.binding, state: "queued", mode, createdAt: Date.now(), startedAt: null, endedAt: null,
      auditId: event.auditId, auditStatus: "pending", errorCode: null, terminationStatus: "not_requested", result: null, outputBytes: 0 };
    this.records.set(jobId, record);
    this.active.set(jobId, { request, event, controller: new AbortController(), queuedAt: performance.now(), activityAt: null, truncated: false });
    try { await this.store!.operation(async () => { await this.cleanup(); await this.store!.save(jobId, record); }); }
    catch (error) {
      this.active.delete(jobId); this.records.delete(jobId); this.fault = true;
      await this.executor.writeJobAudit({ ...event, phase: "failed", timestamp: new Date().toISOString(), errorCode: "JOB_STORAGE_UNAVAILABLE" });
      throw error;
    }
    if (!this.timer) { this.timer = setInterval(() => { void this.pump().catch(() => this.fail()); }, 250); this.timer.unref(); }
    // The durable record is the acceptance boundary: disconnect afterwards does
    // not cancel the job. Reusing requestId recovers a lost response.
    void this.pump().catch(() => this.fail());
    return this.summary(record);
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.stopping || this.fault) return;
    this.pumping = true;
    try {
      if (performance.now() - this.cleanupAt >= 60000) { await this.store!.operation(() => this.cleanup()); this.cleanupAt = performance.now(); }
      for (const [id, active] of this.active) {
        const record = this.records.get(id)!;
        if (record.state !== "queued") continue;
        if (performance.now() - active.queuedAt >= 600000 || !this.executor.acceptingCommands) {
          await this.finishQueued(record, active, "JOB_QUEUE_EXPIRED"); continue;
        }
        const releaseSlot = this.executor.reserveJobSlot();
        if (!releaseSlot) break;
        record.state = "starting";
        active.operation = this.run(record, active, releaseSlot);
        void active.operation.catch(() => this.fail());
      }
    } finally { this.pumping = false; }
  }
  private async run(record: Record, active: Active, releaseSlot: () => void): Promise<void> {
    let enteredExecutor = false;
    try {
      await this.store!.operation(() => this.store!.save(record.jobId, record));
      record.state = "running"; record.startedAt = Date.now();
      await this.store!.operation(() => this.store!.save(record.jobId, record));
      enteredExecutor = true;
      const result = await this.executor.executeJob(active.request, active.controller.signal, { attempted: active.event, mode: record.mode,
        activity: (bytes, truncated) => { active.activityAt = Date.now(); active.truncated = truncated; record.outputBytes = Math.min(Number.MAX_SAFE_INTEGER, record.outputBytes + bytes); },
        releaseSlot,
        finalizing: () => { record.state = "finalizing"; } });
      record.result = result; record.state = result.timedOut ? "timed_out" : result.ok ? "completed" : "failed"; record.auditStatus = "confirmed";
      if (result.timedOut) record.terminationStatus = "confirmed";
    } catch (error) {
      if (error instanceof CommandExecutionError) record.execution = error.evidence;
      record.errorCode = error instanceof AppError ? error.code : "JOB_EXECUTION_FAILED";
      record.state = active.controller.signal.aborted ? "cancelled" : "failed";
      record.result = null;
      record.auditStatus = record.errorCode.startsWith("AUDIT_") ? "unavailable" : "confirmed";
      if (!enteredExecutor) {
        try { await this.executor.writeJobAudit({ ...active.event, phase: "failed", timestamp: new Date().toISOString(), errorCode: record.errorCode }); }
        catch { record.auditStatus = "unavailable"; }
      }
      if (record.errorCode === "COMMAND_TERMINATION_FAILED") { record.terminationStatus = "unknown"; record.state = "failed"; }
      else if (active.controller.signal.aborted) record.terminationStatus = "confirmed";
    } finally {
      releaseSlot();
      record.endedAt = Date.now();
      try { await this.store!.operation(() => this.store!.save(record.jobId, record)); } catch { this.fail(); record.result = null; record.errorCode = "JOB_STORAGE_UNAVAILABLE"; }
      this.active.delete(record.jobId);
    }
  }
  private async finishQueued(record: Record, active: Active, errorCode: string): Promise<void> {
    record.state = errorCode === "JOB_CANCELLED" ? "cancelled" : "failed"; record.errorCode = errorCode; record.endedAt = Date.now();
    try { await this.executor.writeJobAudit({ ...active.event, phase: "blocked", timestamp: new Date().toISOString(), errorCode }); record.auditStatus = "confirmed"; }
    catch { record.auditStatus = "unavailable"; }
    this.active.delete(record.jobId);
    await this.store!.operation(() => this.store!.save(record.jobId, record));
  }
  private find(jobId: string): Record {
    z.string().uuid().parse(jobId);
    const item = this.records.get(jobId.toLowerCase());
    if (!item) throw new AppError("JOB_NOT_FOUND", "No retained background job has this ID.");
    return item;
  }
  async get(jobId: string) { this.assertEnabled(); await this.initialize(); return this.summary(this.find(jobId)); }
  async list(offset = 0, limit = 20) {
    this.assertEnabled(); await this.initialize();
    z.number().int().min(0).max(100).parse(offset); z.number().int().min(1).max(50).parse(limit);
    const records = [...this.records.values()].sort((a,b) => b.createdAt - a.createdAt || a.jobId.localeCompare(b.jobId));
    return { jobs: records.slice(offset, offset + limit).map(r => this.summary(r)), nextOffset: offset + limit < records.length ? offset + limit : null };
  }
  async output(jobId: string, stream: "stdout" | "stderr" = "stdout", cursor = 0, maxChars = 8000) {
    this.assertEnabled(); await this.initialize(); z.enum(["stdout", "stderr"]).parse(stream);
    z.number().int().min(0).max(5242880).parse(cursor); z.number().int().min(1).max(8000).parse(maxChars);
    const record = this.find(jobId);
    if (this.active.has(record.jobId) || record.auditStatus !== "confirmed" || !record.result) throw new AppError("JOB_OUTPUT_UNAVAILABLE", "Output is withheld until terminal Audit and storage succeed.");
    const text = record.result[stream];
    if (cursor > text.length || (cursor > 0 && /[\uDC00-\uDFFF]/.test(text[cursor] ?? ""))) throw new AppError("JOB_CURSOR_INVALID", "Invalid output cursor.");
    let end = Math.min(text.length, cursor + maxChars);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    if (end === cursor && cursor < text.length) throw new AppError("JOB_PAGE_TOO_SMALL", "Increase maxChars to return a complete Unicode character.");
    return { jobId, stream, text: text.slice(cursor, end), nextCursor: end, eof: end === text.length, truncated: record.result.truncated };
  }
  async cancel(jobId: string) {
    this.assertEnabled(); await this.initialize(); const record = this.find(jobId), active = this.active.get(record.jobId);
    if (active) {
      if (record.state === "queued") await this.finishQueued(record, active, "JOB_CANCELLED");
      else if (["starting", "running"].includes(record.state)) { record.terminationStatus = "requested"; active.controller.abort(); }
    }
    return this.summary(record);
  }
  async shutdown(): Promise<void> {
    this.stopping = true; if (this.timer) clearInterval(this.timer);
    const pending: Promise<unknown>[] = [...this.submissions.values()].map(s => s.operation);
    for (const [id, active] of this.active) {
      if (active.operation) { active.controller.abort(); pending.push(active.operation); }
      else pending.push(this.finishQueued(this.records.get(id)!, active, "JOB_CANCELLED"));
    }
    await Promise.allSettled(pending); await this.store?.drain();
  }
}
