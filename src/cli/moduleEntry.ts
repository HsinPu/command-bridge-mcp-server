import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Compare physical files so managed current/release links remain executable. */
export function isModuleEntry(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
