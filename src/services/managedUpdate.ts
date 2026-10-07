import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { createAuditEvent, type AuditLog } from "./auditLog.js";

export const updateJobSchema = z.object({
  schemaVersion: z.literal(1), jobId: z.string().uuid(), state: z.enum(["accepted", "running", "succeeded", "failed", "interrupted"]),
  startedAt: z.string(), finishedAt: z.string().nullable(),
  before: z.object({ version: z.string(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/) }),
  after: z.object({ version: z.string(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/) }).nullable(),
  errorCode: z.string().nullable()
}).strict();
export type UpdateJob = z.infer<typeof updateJobSchema>;
export interface UpdateAdapter { start(): Promise<UpdateJob>; status(jobId?: string): Promise<UpdateJob> }

// Inputs never become shell text, executable paths, task names or installer flags.
export function runUpdateControl(executable: string, args: string[], deadlineMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", windir: process.env.SystemRoot ?? "C:\\Windows", ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files", ProgramData: process.env.ProgramData ?? "C:\\ProgramData", TEMP: process.env.TEMP ?? "C:\\Windows\\Temp", PATH: (process.env.SystemRoot ?? "C:\\Windows") + "\\System32" } : { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
    let output = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output); };
    const failure = () => {
      let location = "";
      try {
        const diagnostic = z.object({controlError:z.literal(true),stage:z.number().int().min(0).max(10),hresult:z.number().int().min(-2147483648).max(2147483647),line:z.number().int().min(0).max(10000)}).strict().parse(JSON.parse(output));
        location = ` (control-stage=${diagnostic.stage}, hresult=${diagnostic.hresult}, line=${diagnostic.line})`;
      } catch {}
      return new AppError("UPDATE_CONTROL_FAILED", "Update control did not acknowledge the request." + location, "Query update status before retrying; an independent job may already have started.");
    };
    const timer = setTimeout(() => { child.kill(); finish(failure()); }, deadlineMs);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 8192) { child.kill(); finish(failure()); } });
    child.once("error", () => finish(failure()));
    child.once("close", code => finish(code === 0 ? undefined : failure()));
  });
}

export function nativeUpdateAdapter(): UpdateAdapter {
  const windows = process.platform === "win32";
  const stateRoot = windows ? join(process.env.ProgramData ?? "C:\\ProgramData", "CommandBridgeUpdate") : "/var/lib/command-bridge-update";
  const read = async (id?: string): Promise<UpdateJob> => {
    if (id) { z.string().uuid().parse(id); id = id.toLowerCase(); }
    try {
      if (windows) {
        const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        return updateJobSchema.parse(JSON.parse(await runUpdateControl(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.env.ProgramFiles ?? "C:\\Program Files", "CommandBridgeUpdate", "status.ps1"), ...(id ? ["-JobId", id] : [])])));
      }
      const job = updateJobSchema.parse(JSON.parse(await readFile(join(stateRoot, id ? id + ".json" : "latest.json"), "utf8")));
      if (["accepted", "running"].includes(job.state)) {
        const active = await runUpdateControl("/usr/bin/systemctl", ["show", "command-bridge-update.service", "--property=ActiveState", "--value"]);
        if (!["active", "activating", "deactivating"].includes(active.trim())) return { ...job, state: "interrupted", errorCode: "UPDATE_INTERRUPTED" };
      }
      return job;
    }
    catch { throw new AppError("UPDATE_STATUS_UNAVAILABLE", "No readable managed update record was found.", "A service installation is required. Query without a jobId for the latest accepted job."); }
  };
  return {
    status: read,
    async start() {
      if (windows) {
        const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const script = join(process.env.ProgramFiles ?? "C:\\Program Files", "CommandBridgeUpdate", "request.ps1");
        return updateJobSchema.parse(JSON.parse(await runUpdateControl(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script])));
      }
      if (process.platform !== "linux") throw new AppError("UPDATE_UNAVAILABLE", "Managed updates require a Linux or Windows service installation.", "Use the package manager for an npm installation.");
      return updateJobSchema.parse(JSON.parse(await runUpdateControl("/usr/bin/sudo", ["-n", "/usr/local/libexec/command-bridge-update/request"])));
    }
  };
}

export class ManagedUpdateService {
  private pending?: Promise<UpdateJob>;
  private stopping = false;
  private readonly operations = new Set<Promise<UpdateJob>>();
  constructor(private readonly config: AppConfig, private readonly audit: AuditLog, private readonly adapter = nativeUpdateAdapter()) {}
  stop(): void { this.stopping = true; }
  async shutdown(): Promise<void> { this.stop(); await Promise.allSettled([...this.operations]); }
  status(jobId?: string): Promise<UpdateJob> { return this.adapter.status(jobId); }
  start(signal?: AbortSignal): Promise<UpdateJob> {
    const operation = this.startInternal(signal);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }
  private dispatch(): Promise<UpdateJob> {
    if (!this.pending) {
      const operation = this.adapter.start();
      this.pending = operation;
      void operation.finally(() => { if (this.pending === operation) this.pending = undefined; }).catch(() => undefined);
    }
    return this.pending;
  }
  private async startInternal(signal?: AbortSignal): Promise<UpdateJob> {
    const event = createAuditEvent({ command: "CommandBridge managed update request", phase: "attempted", executionMode: this.config.executionMode, source: this.config.transport === "http" ? "http-bearer" : "stdio" });
    await this.audit.write(event);
    let job: UpdateJob;
    try {
      if (this.stopping || signal?.aborted || this.config.mcpUpdateEnabled === false) throw new AppError("UPDATE_DISABLED", "Managed update requests are disabled or stopping.", "An administrator can enable COMMAND_BRIDGE_MCP_UPDATE_ENABLED.");
      job = await this.dispatch();
    } catch (error) {
      await this.audit.write({ ...event, timestamp: new Date().toISOString(), phase: error instanceof AppError && error.code === "UPDATE_DISABLED" ? "blocked" : "failed", errorCode: error instanceof AppError ? error.code : "UPDATE_CONTROL_FAILED" });
      throw error;
    }
    // Completion records acceptance, not successful installation. The root-owned
    // task record is the authority for execution/recovery across MCP restarts.
    try { await this.audit.write({ ...event, command: "CommandBridge update accepted: " + job.jobId, timestamp: new Date().toISOString(), phase: "completed" }); }
    catch { throw new AppError("UPDATE_ACCEPTED_AUDIT_FAILED", "An update may already be running, but acceptance Audit failed.", "Reconnect and query the latest update status before retrying."); }
    return job;
  }
}
