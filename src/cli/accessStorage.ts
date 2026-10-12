import { chmod, chown, lstat, open, rename, unlink, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertAdminPath, readRecord } from "./managedFiles.js";
import { runServiceQuery } from "./serviceStatus.js";
import { CliError } from "./connectionSetup.js";

export const accessLeasePath = () => process.platform === "linux" ? "/etc/command-bridge/access-lease.json" : join(process.env.ProgramData ?? "C:\\ProgramData", "CommandBridgeMCP/access-lease.json");
async function windowsStorage(action: "read" | "write", payload?: string) {
  const root = process.env.SystemRoot ?? "C:\\Windows", script = fileURLToPath(new URL("../../scripts/windows/temporary-access.ps1", import.meta.url));
  // Retain the real operation until process AND pipes close. The controller's
  // response deadline must not turn unfinished storage into repeated helpers.
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, action], {
      env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP, COMMAND_BRIDGE_ACCESS_PAYLOAD: payload }, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    let invalid = false, bytes = 0; const chunks: Buffer[] = [];
    const stop = () => { invalid = true; try { child.kill(); } catch { /* Keep tracking the actual helper until close. */ } };
    const timer = setTimeout(stop, 3000);
    child.stdout.on("data", (b: Buffer) => { bytes += b.length; if (bytes > 4096) stop(); else chunks.push(b); });
    child.once("error", () => { clearTimeout(timer); reject(new CliError("ACCESS_STORAGE_UNAVAILABLE")); });
    child.once("close", code => { clearTimeout(timer); if (invalid || code !== 0) reject(new CliError("ACCESS_STORAGE_UNAVAILABLE")); else resolve(Buffer.concat(chunks).toString("utf8")); });
  });
  return result.trim() === "ABSENT" ? null : result;
}
export async function readAccessLease(): Promise<string | null> {
  if (process.platform === "win32") return windowsStorage("read");
  const path = accessLeasePath();
  try { await assertAdminPath(path); return Buffer.from(await readRecord(path, 4096)).toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await assertAdminPath(dirname(path)); return null; } throw error; }
}
export async function writeAccessLease(payload: string): Promise<void> {
  if (process.platform === "win32") { await windowsStorage("write", payload); return; }
  if (process.geteuid?.() !== 0) throw new CliError("ADMINISTRATOR_REQUIRED");
  const path = accessLeasePath(), parent = dirname(path);
  await assertAdminPath(parent);
  try { await assertAdminPath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = join(parent, ".access-lease." + randomUUID());
  try {
    const file = await open(stage, "wx", 0o600);
    try { await file.writeFile(payload, "utf8"); await file.sync(); } finally { await file.close(); }
    await chown(stage, 0, (await lstat(parent)).gid); await chmod(stage, 0o640);
    await rename(stage, path);
    // On SELinux hosts apply and verify the existing host label policy.
    try { await lstat("/sys/fs/selinux/enforce"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const [tool, args] of [["restorecon", [path]], ["matchpathcon", ["-V", path]]] as const) {
      const original = "/usr/sbin/" + tool;
      await assertAdminPath(dirname(original));
      const link = await lstat(original); if (link.uid !== 0) throw new CliError("ACCESS_LABEL_TOOL_UNSAFE");
      const executable = await realpath(original); await assertAdminPath(executable);
      if (await runServiceQuery(executable, [...args], { PATH: "/usr/bin:/bin", LANG: "C" }) === null) throw new CliError("ACCESS_LABEL_FAILED");
    }
  } finally { await unlink(stage).catch(() => undefined); }
}
