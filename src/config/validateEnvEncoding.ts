import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { decodeUtf8File } from "../services/textEncoding.js";

// Validate before dotenv performs its permissive byte-to-text conversion. Keep
// explicit legacy dotenv encoding overrides compatible; UTF-8 is our default.
const encoding = process.env.DOTENV_CONFIG_ENCODING?.toLowerCase().replaceAll("-", "");
if (encoding === undefined || encoding === "utf8") {
  const file = process.env.DOTENV_CONFIG_PATH ?? resolve(".env");
  const expanded = file.startsWith("~") ? join(homedir(), file.slice(1)) : file;
  try { decodeUtf8File(readFileSync(expanded)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
