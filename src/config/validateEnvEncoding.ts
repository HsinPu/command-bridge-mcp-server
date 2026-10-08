import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { decodeUtf8File } from "../services/textEncoding.js";

// Validate before dotenv performs its permissive byte-to-text conversion. Keep
// explicit legacy dotenv encoding overrides compatible; UTF-8 is our default.
const require = createRequire(import.meta.url);
// Use dotenv's exported option matcher so the validated file and encoding are
// the ones dotenv/config will actually load, including last CLI value wins.
const cli = require("dotenv/lib/cli-options")(process.argv) as { path?: string; encoding?: string };
const options = { path: process.env.DOTENV_CONFIG_PATH, encoding: process.env.DOTENV_CONFIG_ENCODING, ...cli };
const encoding = (options.encoding || "utf8").toLowerCase().replaceAll("-", "");
if (encoding === "utf8") {
  const file = options.path || resolve(".env");
  const expanded = file.startsWith("~") ? join(homedir(), file.slice(1)) : file;
  try { decodeUtf8File(readFileSync(expanded)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
