import { constants } from "node:fs";
import { open, lstat, realpath, link, unlink, opendir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { AppError } from "../errors/AppError.js";
import type { AppConfig } from "../config/env.js";
import { createAuditEvent, runFixedProcess, type AuditLog, type FileTransferAudit } from "./auditLog.js";

export interface UploadFileRequest { path: string; contentBase64: string; sha256: string; overwrite?: boolean; expectedSha256?: string }
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(name) &&
  !name.endsWith(".") && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) &&
  !/^(policy|command-bridge|audit|token)(?:\.|$)/i.test(name);

export class FileTransferService {
  private active = false;
  private stopping = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly config: AppConfig, private readonly audit: AuditLog) {}
  async shutdown() { this.stopping = true; await Promise.allSettled([...this.pending]); }

  upload(request: UploadFileRequest, signal?: AbortSignal) {
    return this.perform("upload", request.path, signal, async (base, check, metadata) => {
      if (request.overwrite) throw new AppError("FILE_OVERWRITE_DISABLED", "Atomic conditional overwrite is not supported; choose a new filename.");
      const limit = this.config.fileTransfer!.maxBytes;
      if (typeof request.contentBase64 !== "string" || request.contentBase64.length > 4 * Math.ceil(limit / 3)) throw new AppError("FILE_TOO_LARGE", "Encoded file exceeds the configured limit.");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.contentBase64)) throw new AppError("FILE_ENCODING_INVALID", "Canonical Base64 is required.");
      const data = Buffer.from(request.contentBase64, "base64");
      if (data.length > limit) throw new AppError("FILE_TOO_LARGE", "File exceeds the configured limit.");
      if (data.toString("base64") !== request.contentBase64 || digest(data) !== request.sha256) throw new AppError("FILE_HASH_MISMATCH", "File encoding or SHA-256 does not match.");
      metadata.size = data.length; metadata.sha256 = request.sha256;
      const temporary = join(base, ".upload-" + randomUUID());
      let handle;
      let created = false;
      try {
        check();
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        await handle.writeFile(data); await handle.sync();
        check();
        const own = await handle.stat(), entry = await lstat(temporary);
        if (!entry.isFile() || entry.isSymbolicLink() || own.ino !== entry.ino || own.dev !== entry.dev || own.nlink !== 1) throw new AppError("FILE_PATH_CHANGED", "Temporary file identity changed.");
        // Exclusive link is an atomic no-replace publication on both supported platforms.
        await link(temporary, join(base, request.path));
        metadata.committed = true;
        const final = await lstat(join(base, request.path));
        if (!final.isFile() || final.isSymbolicLink() || final.ino !== own.ino || final.dev !== own.dev) throw new AppError("FILE_PATH_CHANGED", "Published file identity changed; the destination may exist.");
        return { path: request.path, size: data.length, sha256: metadata.sha256 };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("FILE_EXISTS", "Destination already exists; no overwrite was performed.");
        throw error;
      } finally { try { await handle?.close(); } finally { if (created) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw new AppError("FILE_CLEANUP_FAILED", "Temporary cleanup failed; a file may remain."); }); } }
    });
  }

  download(path: string, signal?: AbortSignal) {
    return this.perform("download", path, signal, async (base, check, metadata) => {
      const filename = join(base, path), before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new AppError("FILE_TYPE_BLOCKED", "Only single-link regular files are supported.");
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const initial = await handle.stat();
        if (!initial.isFile() || initial.nlink !== 1 || initial.ino !== before.ino || initial.dev !== before.dev) throw new AppError("FILE_PATH_CHANGED", "File identity changed before reading.");
        const limit = this.config.fileTransfer!.maxBytes;
        if (initial.size > limit) throw new AppError("FILE_TOO_LARGE", "File exceeds the configured limit.");
        const buffer = Buffer.alloc(limit + 1); let count = 0;
        while (count < buffer.length) { check(); const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); if (!bytesRead) break; count += bytesRead; }
        check();
        if (count > limit) throw new AppError("FILE_TOO_LARGE", "File grew beyond the configured limit.");
        const after = await handle.stat(), entry = await lstat(filename);
        if (initial.size !== count || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs || after.nlink !== 1 || entry.isSymbolicLink() || entry.ino !== initial.ino || entry.dev !== initial.dev) throw new AppError("FILE_CHANGED", "File changed during download.");
        const data = buffer.subarray(0, count); metadata.size = count; metadata.sha256 = digest(data);
        return { path, size: count, sha256: metadata.sha256, contentBase64: data.toString("base64") };
      } finally { await handle.close(); }
    });
  }

  private perform<T>(operation: "upload" | "download", path: string, signal: AbortSignal | undefined,
    action: (base: string, check: () => void, metadata: FileTransferAudit) => Promise<T>): Promise<T & { auditId: string; ok: true }> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
    const operationPromise = this.performInternal(operation, path, controller.signal, action);
    this.pending.add(operationPromise);
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel(); reject(new AppError("FILE_TIMEOUT", "Transfer timed out; an upload may exist. Cleanup and Audit continue while storage finishes.")); }, 15000); });
    void operationPromise.finally(() => this.pending.delete(operationPromise)).catch(() => undefined);
    return Promise.race([operationPromise, deadline]).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); });
  }

  private async performInternal<T>(operation: "upload" | "download", path: string, signal: AbortSignal | undefined,
    action: (base: string, check: () => void, metadata: FileTransferAudit) => Promise<T>): Promise<T & { auditId: string; ok: true }> {
    const auditId = randomUUID(), started = Date.now();
    const metadata: FileTransferAudit = { schemaVersion: 1, operation, path: validName(path) ? path : null, size: null, sha256: null, committed: false };
    const event = (phase: "attempted" | "blocked" | "completed" | "failed", errorCode: string | null = null) => createAuditEvent({ auditId, phase, command: "File " + operation, executionMode: this.config.executionMode, source: this.config.transport === "http" ? "http-bearer" : "stdio", durationMs: Date.now() - started, errorCode, fileTransfer: { ...metadata } });
    try { await this.audit.write(event("attempted")); }
    catch { throw new AppError("FILE_AUDIT_FAILED", "Initial Audit unavailable; no file operation was performed."); }
    let acquired = false, terminal = false;
    const check = () => { if (signal?.aborted || this.stopping) throw new AppError("FILE_CANCELLED", "Transfer cancelled; an upload may already have been committed."); if (Date.now() - started > 15000) throw new AppError("FILE_TIMEOUT", "Transfer exceeded its time budget."); };
    try {
      if (!this.config.fileTransfer?.[operation]) throw new AppError("FILE_TRANSFER_DISABLED", "This file transfer operation is disabled.");
      if (!validName(path)) throw new AppError("FILE_PATH_BLOCKED", "Use a single safe filename; directories, reserved names and control characters are forbidden.");
      check();
      if (this.active) throw new AppError("FILE_TRANSFER_BUSY", "One transfer is already active.");
      this.active = true; acquired = true;
      const root = this.config.fileTransfer.root;
      if (!root || !isAbsolute(root) || await realpath(root) !== resolve(root)) throw new AppError("FILE_ROOT_UNSAFE", "Transfer root must be an existing absolute directory without links.");
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError("FILE_ROOT_UNSAFE", "Unsafe transfer root.");
      if (root === dirname(root) || (this.config.policyFile && resolve(root) === dirname(resolve(this.config.policyFile))) ||
          (process.platform === "linux" && /^\/(etc|proc|sys|dev)(\/|$)/.test(root))) throw new AppError("FILE_ROOT_UNSAFE", "System and configuration directories cannot be transfer roots.");
      let directory;
      let lease: Awaited<ReturnType<typeof lockWindowsRoot>> | undefined;
      try {
        let base = root;
        if (process.platform === "linux") {
          directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const pinned = await directory.stat();
          if (pinned.ino !== info.ino || pinned.dev !== info.dev || (pinned.mode & 0o077) !== 0 ||
              (process.getuid && pinned.uid !== process.getuid())) throw new AppError("FILE_ROOT_UNSAFE", "Transfer root must be private and owned by the service account.");
          base = `/proc/self/fd/${directory.fd}`;
        } else if (process.platform === "win32") {
          try { await validateWindowsRoot(root); } catch { throw new AppError("FILE_ROOT_UNSAFE", "Windows transfer directory ACLs could not be verified."); }
          lease = await lockWindowsRoot(root);
          const afterLock = await lstat(root);
          if (afterLock.isSymbolicLink() || afterLock.ino !== info.ino || afterLock.dev !== info.dev || await realpath(root) !== resolve(root)) throw new AppError("FILE_ROOT_UNSAFE", "Transfer directory changed while acquiring protection.");
        } else throw new AppError("FILE_PLATFORM_UNSUPPORTED", "Secure file transfer is unsupported on this platform.");
        let entries = 0;
        for await (const entry of await opendir(base)) {
          check();
          if (++entries > 1000) throw new AppError("FILE_DIRECTORY_LIMIT", "Transfer directory contains too many entries.");
          if (entry.name.startsWith(".upload-")) throw new AppError("FILE_TEMP_REMAINS", "A previous upload temporary file remains; administrator cleanup is required.");
        }
        check();
        const guardedCheck = () => { check(); if (lease && (lease.child.exitCode !== null || lease.child.signalCode !== null)) throw new AppError("FILE_ROOT_UNSAFE", "Transfer directory protection was lost."); };
        const result = await action(base, guardedCheck, metadata);
        guardedCheck();
        await lease?.release(); lease = undefined;
        await directory?.close(); directory = undefined;
        terminal = true;
        try { await this.audit.write(event("completed")); } catch { throw new AppError(metadata.committed ? "FILE_COMMITTED_AUDIT_FAILED" : "FILE_AUDIT_FAILED", metadata.committed ? "File was committed but terminal Audit failed; do not assume rollback." : "Terminal Audit failed; download content was withheld."); }
        return { ...result, ok: true, auditId };
      } finally { try { await directory?.close(); } finally { await lease?.release(); } }
    } catch (error) {
      const code = error instanceof AppError ? error.code : "FILE_IO_FAILED";
      const blocked = !metadata.committed && ["FILE_TRANSFER_DISABLED", "FILE_PATH_BLOCKED", "FILE_ROOT_UNSAFE", "FILE_TYPE_BLOCKED", "FILE_EXISTS", "FILE_TOO_LARGE", "FILE_ENCODING_INVALID", "FILE_HASH_MISMATCH", "FILE_OVERWRITE_DISABLED", "FILE_TRANSFER_BUSY", "FILE_DIRECTORY_LIMIT", "FILE_TEMP_REMAINS"].includes(code);
      if (!terminal) { terminal = true; try { await this.audit.write(event(blocked ? "blocked" : "failed", code)); } catch { throw new AppError("FILE_AUDIT_FAILED", "Terminal Audit failed; an upload may already exist."); } }
      if (error instanceof AppError) throw error;
      throw new AppError("FILE_IO_FAILED", "File operation failed; inspect host storage and permissions.");
    } finally { if (acquired) this.active = false; }
  }
}

async function validateWindowsRoot(root: string) {
  // Parent and directory ACLs must make rename/reparse replacement impossible
  // for non-administrators. Do not accept a general user-owned transfer root.
  const script = `$ErrorActionPreference='Stop'; $trusted=@('S-1-5-18','S-1-5-32-544'); $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $paths=@($env:CB_ROOT); $parent=$env:CB_PARENT; while($parent){$paths+=,$parent; $parent=[IO.Directory]::GetParent($parent); if($parent){$parent=$parent.FullName}}; foreach($p in $paths) { $a=Get-Acl -LiteralPath $p; $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if($owner -notin $trusted){throw 'owner'}; foreach($r in $a.Access) { if($r.AccessControlType -ne 'Allow'){continue}; $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -in $trusted){continue}; if($p -eq $env:CB_ROOT -and $sid -ne $current){throw 'readable'}; if(([int]$r.PropagationFlags -band 2) -ne 0){continue}; $mask=if($p -eq $env:CB_ROOT){0xD0114}else{0xD0040}; if(([int]$r.FileSystemRights -band $mask) -ne 0){throw 'writable'} } }; 'ok'`;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const output = await runFixedProcess(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), PSModulePath: join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules"), CB_ROOT: root, CB_PARENT: dirname(root) });
  if (output.trim() !== "ok") throw new AppError("FILE_ROOT_UNSAFE", "Transfer ACLs must protect directory identity from non-administrators.");
}

export async function lockWindowsRoot(root: string): Promise<{ child: ChildProcess; release: () => Promise<void> }> {
  // Hold a non-reparse directory handle without delete sharing for the
  // complete operation. Child creation remains allowed, root mutation does not.
  const script = `$ErrorActionPreference='Stop'; [Console]::Error.WriteLine('CB_LEASE_COMPILING'); Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public class CBRootLease { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr q, uint d, uint f, IntPtr t); }'; [Console]::Error.WriteLine('CB_LEASE_OPENING'); $h=[CBRootLease]::CreateFile($env:CB_ROOT,[uint32]2147483648,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero); if($h.IsInvalid){throw 'lock'}; try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); $end=[DateTime]::UtcNow.AddSeconds(30); while(-not [System.IO.File]::Exists($env:CB_RELEASE)) { if([DateTime]::UtcNow -gt $end){throw 'deadline'}; Start-Sleep -Milliseconds 50 } } finally {$h.Dispose()}`;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const control = await mkdtemp(join(tmpdir(), "cb-root-lease-"));
  const releaseFile = join(control, "release");
  const child = spawn(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), PSModulePath: join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules"), TEMP: control, TMP: control, CB_ROOT: root, CB_RELEASE: releaseFile }, stdio: ["pipe", "pipe", "pipe"] });
  // Add-Type invokes the .NET compiler; give it an explicit private writable
  // temporary directory instead of relying on a stripped environment fallback.
  let stage = "startup";
  child.stderr.on("data", (chunk: Buffer) => {
    const marker = chunk.toString().match(/CB_LEASE_(COMPILING|OPENING)/g)?.at(-1);
    if (marker) stage = marker === "CB_LEASE_COMPILING" ? "compile" : "open";
  });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  child.stdin.on("error", () => undefined);
  const stop = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await writeFile(releaseFile, "release", { mode: 0o600 });
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([closed, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
      if (timer) clearTimeout(timer);
      if (code === null) await runFixedProcess(join(systemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], undefined, false);
    }
    await rm(control, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "", settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("Directory lock timed out")), 5000);
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Directory lock failed")));
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 64) finish(new Error("Invalid lock response")); else if (output.trim() === "ready") finish(); });
    });
    return { child, release: stop };
  } catch { await stop(); throw new AppError("FILE_ROOT_UNSAFE", `Could not lock the transfer directory (${stage}); no transfer was performed.`); }
}
