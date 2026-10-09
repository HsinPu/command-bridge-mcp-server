import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, parse as parsePath } from "node:path";
import { CliError } from "./connectionSetup.js";

export async function assertAdminPath(path: string): Promise<void> {
  let cursor = path;
  while (true) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new CliError("INSTALLATION_UNSAFE");
    const parent = dirname(cursor);
    if (cursor === parsePath(cursor).root || parent === cursor) return;
    cursor = parent;
  }
}

/** Descriptor-based bounded reads: no FIFO/device/link or unbounded readFile. */
export async function readRecord(path: string, maxBytes: number): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new CliError("RECORD_INVALID");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || info.ino !== before.ino || info.dev !== before.dev) throw new CliError("RECORD_CHANGED");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes) throw new CliError("RECORD_INVALID");
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new CliError("RECORD_CHANGED");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    return `${await realpath(path)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return "permission-denied";
    throw error;
  }
}

export function readFailure(error: unknown): string {
  if (error instanceof CliError) return error.code;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" ? "NOT_FOUND" : code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "READ_FAILED";
}
