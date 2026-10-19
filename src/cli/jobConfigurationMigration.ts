import { win32, posix } from "node:path";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSavedConfiguration } from "./connectionSetup.js";
import { decodeUtf8File } from "../services/textEncoding.js";

export function migrateManagedJobs(bytes: Uint8Array, defaultRoot: string): Buffer {
  const values = parseSavedConfiguration(bytes);
  const enabled = values.COMMAND_BRIDGE_JOBS_ENABLED;
  if (enabled !== undefined && !["true", "false"].includes(enabled)) throw new Error("Invalid background job enablement.");
  if (enabled === "false") return Buffer.from(bytes);
  const absolute = (value: string) => (process.platform === "win32" ? win32 : posix).isAbsolute(value);
  if (!absolute(defaultRoot) || (values.COMMAND_BRIDGE_JOBS_ROOT !== undefined && !absolute(values.COMMAND_BRIDGE_JOBS_ROOT))) {
    throw new Error("Enabled background jobs require an absolute storage path.");
  }
  const defaults: Record<string, string> = {
    COMMAND_BRIDGE_JOBS_ENABLED: "true",
    COMMAND_BRIDGE_JOBS_ROOT: defaultRoot,
    COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS: "1800000",
    COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS: "3600000"
  };
  const defaultMs = Number(values.COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS ?? defaults.COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS);
  const maxMs = Number(values.COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS ?? defaults.COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS);
  if (![defaultMs, maxMs].every(n => Number.isInteger(n) && n >= 1000 && n <= 86400000) || defaultMs > maxMs) throw new Error("Invalid background job timeouts.");
  if (Object.keys(defaults).every(key => values[key] !== undefined)) return Buffer.from(bytes);
  const quote = defaultRoot.includes("'") ? "`" : "'";
  if (defaultRoot.includes(quote) || /[\r\n\0]/.test(defaultRoot)) throw new Error("Unsupported managed job storage path.");
  let text = decodeUtf8File(bytes);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(defaults)) {
    if (values[key] !== undefined) continue;
    if (text && !text.endsWith("\n")) text += newline;
    text += `${key}=${key === "COMMAND_BRIDGE_JOBS_ROOT" ? quote + value + quote : value}${newline}`;
  }
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  return Buffer.from((bom ? "\uFEFF" : "") + text, "utf8");
}

function isInstallerEntry(): boolean {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isInstallerEntry()) {
  try {
    const [input, output, root] = process.argv.slice(2);
    if (!input || !output || !root) throw new Error();
    const bytes = readFileSync(input);
    const migrated = migrateManagedJobs(bytes, root);
    writeFileSync(output, migrated, { flag: "wx", mode: 0o600 });
    console.log(bytes.equals(migrated) ? "unchanged" : "migrated");
  } catch { console.error("Background job configuration migration failed; inspect enablement, absolute storage path and timeout settings."); process.exitCode = 1; }
}
