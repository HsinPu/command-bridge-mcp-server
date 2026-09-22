import { mkdir, chmod, lstat, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serializeAuditEvent, parseWindowsEventLogLines, type AuditLog, type CommandAuditEvent, type AuditEventList } from "./auditLog.js";

const exec = promisify(execFile);
export class FileAuditLog implements AuditLog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory = join(process.platform === "win32" ? process.env.LOCALAPPDATA ?? homedir() : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "CommandBridgeMCP", "audit"),
    private readonly maxBytes = 10 * 1024 * 1024
  ) {}

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe audit directory.");
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const { stdout } = await exec(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 });
      const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error("Cannot determine audit owner.");
      // Replace all rules, including explicit rules on an existing directory.
      const script = "$acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid = New-Object Security.Principal.SecurityIdentifier($env:COMMAND_BRIDGE_AUDIT_SID); $acl.SetOwner($sid); $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($env:COMMAND_BRIDGE_AUDIT_DIRECTORY,$acl)";
      const protectFiles = "; foreach ($path in [IO.Directory]::GetFiles($env:COMMAND_BRIDGE_AUDIT_DIRECTORY)) { if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe audit file' }; $fileAcl = New-Object Security.AccessControl.FileSecurity; $fileAcl.SetAccessRuleProtection($true,$false); $fileAcl.SetOwner($sid); $fileRule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $fileAcl.AddAccessRule($fileRule); [IO.File]::SetAccessControl($path,$fileAcl) }";
      await exec(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + script + protectFiles], { windowsHide: true, timeout: 5000, env: { ...process.env, COMMAND_BRIDGE_AUDIT_DIRECTORY: this.directory, COMMAND_BRIDGE_AUDIT_SID: sid } });
    } else {
      if (stat.uid !== process.getuid?.()) throw new Error("Audit directory belongs to another user.");
      await chmod(this.directory, 0o700);
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  write(event: CommandAuditEvent): Promise<void> {
    return this.serialize(async () => {
      await this.prepare();
      const line = serializeAuditEvent(event) + "\n";
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("Audit event exceeds file limit.");
      const path = join(this.directory, "events.jsonl");
      let size = 0;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe audit file.");
        size = stat.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await rm(path + ".4", { force: true });
        for (let i = 3; i >= 0; i--) {
          try { await rename(i ? path + "." + i : path, path + "." + (i + 1)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { if (process.platform !== "win32") await handle.chmod(0o600); await handle.writeFile(line); await handle.sync(); }
      finally { await handle.close(); }
    });
  }

  list(limit: number): Promise<AuditEventList> {
    return this.serialize(async () => {
      await this.prepare();
      const events: CommandAuditEvent[] = [];
      for (let i = 0; i < 5; i++) {
        const path = join(this.directory, "events.jsonl" + (i ? "." + i : ""));
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw new Error("Unsafe audit file.");
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try { events.push(...parseWindowsEventLogLines(await handle.readFile("utf8")).reverse()); }
          finally { await handle.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (events.length > limit) break;
      }
      const count = Math.max(1, Math.min(100, Math.trunc(limit)));
      return { events: events.slice(0, count), hasMore: events.length > count };
    });
  }
}
