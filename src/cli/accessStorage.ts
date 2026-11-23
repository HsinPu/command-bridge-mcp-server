import { lstat, open, rename, unlink, realpath } from "node:fs/promises";
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
  await publishLinuxAccessLease(path, payload, (await lstat(parent)).gid, labelLinuxAccessLease);
}

async function runLabelTool(path: string, args: string[]): Promise<string | null> {
  await assertAdminPath(dirname(path));
  const link = await lstat(path);
  if (link.uid !== 0) throw new CliError("ACCESS_LABEL_TOOL_UNSAFE");
  const executable = await realpath(path);
  await assertAdminPath(executable);
  return runServiceQuery(executable, args, { PATH: "/usr/bin:/bin", LANG: "C" });
}

export async function applyLinuxAccessLabel(stage: string, destination: string, run = runLabelTool): Promise<void> {
  // Use the final filename's policy, including name-specific regular-file rules.
  const expected = (await run("/usr/sbin/matchpathcon", ["-n", "-m", "file", destination]))?.trim();
  if (!expected || !/^[^\s:]+:[^\s:]+:[^\s:]+:[^\x00-\x1f\x7f]+$/.test(expected)) {
    throw new CliError("ACCESS_LABEL_FAILED");
  }
  const readLabel = async () => (await run("/usr/bin/stat", ["--format=%C", "--", stage]))?.trim();
  const actual = await readLabel();
  if (actual === undefined) throw new CliError("ACCESS_LABEL_FAILED");
  if (actual === expected) return;
  if (await run("/usr/bin/chcon", ["--", expected, stage]) === null || await readLabel() !== expected) {
    throw new CliError("ACCESS_LABEL_FAILED");
  }
}

async function labelLinuxAccessLease(stage: string, destination: string): Promise<void> {
  try { await lstat("/sys/fs/selinux/enforce"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await applyLinuxAccessLabel(stage, destination);
}

export async function publishLinuxAccessLease(
  path: string, payload: string, group: number, label: (stage: string, destination: string) => Promise<void>
): Promise<void> {
  const stage = join(dirname(path), ".access-lease." + randomUUID());
  const file = await open(stage, "wx", 0o600);
  try {
    try {
      await file.writeFile(payload, "utf8");
      await file.chown(0, group);
      await file.chmod(0o640);
      await label(stage, path);
      await file.sync();
    } finally { await file.close(); }
    // A failed label operation must never publish an open or close record.
    await rename(stage, path);
  } finally { await unlink(stage).catch(() => undefined); }
}
