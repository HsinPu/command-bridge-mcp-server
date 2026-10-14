import { lstat, open, realpath, readdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors/AppError.js";
import { buildWindowsAuditEnvironment, runFixedProcess } from "./auditLog.js";
import { decodeUtf8File } from "./textEncoding.js";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const JOB_QUOTA_BYTES = 100 * 1024 * 1024;

// Only this module constructs filenames. Timed-out I/O remains tracked; the store
// latches unavailable rather than starting overlapping replacement operations.
export class JobStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private lockId?: string;
  constructor(readonly root: string) {}
  operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.failed) return Promise.reject(new AppError("JOB_STORAGE_UNAVAILABLE", "Background job storage is unavailable; inspect the host and restart."));
    const deadline = performance.now() + 5000;
    const actual = this.queue.then(async () => {
      if (this.failed || performance.now() >= deadline) throw new Error("Job storage budget expired.");
      await this.validate();
      const value = await action();
      if (performance.now() >= deadline) throw new Error("Job storage budget expired.");
      return value;
    });
    this.queue = actual.catch(() => undefined);
    let timer: NodeJS.Timeout;
    return Promise.race([actual, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Job storage timed out.")), 5000); })])
      .catch(error => { this.failed = true; throw new AppError("JOB_STORAGE_UNAVAILABLE", "Background job storage failed; inspect the host and restart.", undefined, { cause: error }); })
      .finally(() => clearTimeout(timer));
  }
  private async validate(): Promise<void> {
    if (!this.root || resolve(this.root) !== this.root) throw new Error("Job root must be canonical and absolute.");
    let cursor = this.root;
    while (true) {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cursor) !== cursor) throw new Error("Unsafe job directory.");
      if (process.platform !== "win32") {
        if (cursor === this.root) {
          if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Job directory must be private and belong to the service.");
        } else if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0)) throw new Error("Unsafe job ancestor.");
      }
      const parent = dirname(cursor);
      if (cursor === parent) break;
      cursor = parent;
    }
    if (process.platform === "win32") {
      const system = process.env.SystemRoot ?? "C:\\Windows";
      // Use .NET ACL APIs with autoload disabled; reject extra readers as output
      // may contain secrets. Administrators, SYSTEM and the service SID only.
      const script = "$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $p=$env:COMMAND_BRIDGE_JOB_ROOT; $a=[IO.Directory]::GetAccessControl($p); if (!$a.AreAccessRulesProtected) {throw 'Unprotected jobs'}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {throw 'Extra job access'}}; if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {throw 'Unsafe job owner'}; foreach($f in [IO.Directory]::GetFiles($p)) {if (([IO.File]::GetAttributes($f) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Job file link'}; $c=[IO.File]::GetAccessControl($f); if($c.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {throw 'Job file owner'}; foreach($r in $c.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {throw 'Job file access'}}}; while($p) {$i=[IO.DirectoryInfo]::new($p); if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Job reparse point'}; if($i.Parent) {$p=$i.Parent.FullName; $b=[IO.Directory]::GetAccessControl($p); foreach($r in $b.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {if($r.AccessControlType -eq 'Allow' -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $r.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -and ([int]$r.FileSystemRights -band 65600) -ne 0) {throw 'Writable ancestor'}}} else {$p=$null}}";
      await runFixedProcess(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { ...buildWindowsAuditEnvironment(system), COMMAND_BRIDGE_JOB_ROOT: this.root }, false, 5000);
    }
  }
  private path(id: string): string { if (!uuid.test(id)) throw new AppError("JOB_ID_INVALID", "Invalid job ID."); return join(this.root, id + ".json"); }
  async acquire(binding: string): Promise<void> {
    const path = join(this.root, ".owner.json");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe job owner record.");
      const owner = JSON.parse(decodeUtf8File(await (await import("node:fs/promises")).readFile(path)));
      if (owner.schemaVersion !== 1 || owner.binding !== binding || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !uuid.test(owner.lockId)) throw new Error("Job owner mismatch.");
      try { process.kill(owner.pid, 0); throw new Error("Job storage is already in use."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const lockId = randomUUID();
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    this.lockId = lockId;
    try { await file.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, lockId: this.lockId, binding })); await file.sync(); }
    finally { await file.close(); }
    // Only our exact temporary filenames are eligible for crash cleanup.
    for (const name of await readdir(this.root)) {
      if (!/^\.[a-f0-9-]{36}\.tmp$/i.test(name)) continue;
      const stat = await lstat(join(this.root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error("Unsafe job temporary file.");
      await unlink(join(this.root, name));
    }
  }
  async files(): Promise<string[]> {
    const names = await readdir(this.root);
    if (names.length > 1000) throw new Error("Too many job records.");
    if (names.some(name => name !== ".owner.json" && !/^[a-f0-9-]{36}\.json$/i.test(name))) throw new Error("Unexpected job storage entry.");
    return names.filter(name => name !== ".owner.json").map(name => name.slice(0, -5));
  }
  async read(id: string): Promise<string> {
    const path = this.path(id);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 22 * 1024 * 1024 || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error("Unsafe job record.");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const actual = await file.stat(); if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error("Job record changed."); return decodeUtf8File(await file.readFile()); }
    finally { await file.close(); }
  }
  async save(id: string, value: unknown): Promise<void> {
    const path = this.path(id), text = JSON.stringify(value);
    let total = 0;
    for (const other of await this.files()) { if (other !== id) { const stat = await lstat(this.path(other)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe job record."); total += stat.size; } }
    if (total + Buffer.byteLength(text) > JOB_QUOTA_BYTES) throw new Error("Job storage quota reached.");
    const temporary = join(this.root, "." + randomUUID() + ".tmp");
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async remove(id: string): Promise<void> { await this.read(id); await unlink(this.path(id)); }
  async drain(): Promise<void> {
    await this.queue;
    if (this.lockId) {
      const path = join(this.root, ".owner.json");
      const owner = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
      if (owner.lockId !== this.lockId) throw new Error("Job owner changed.");
      await unlink(path); this.lockId = undefined;
    }
  }
}
