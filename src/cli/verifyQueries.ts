import { pathToFileURL } from "node:url";
import { parseSavedConfiguration, CliError } from "./connectionSetup.js";
import { readRecord, readFailure } from "./managedFiles.js";
import { decodeUtf8File } from "../services/textEncoding.js";

/** Fixed installer assertion; captured CLI output remains in the private transaction. */
export async function verifyQueries(args: string[]) {
  if (args.length !== 4) throw new CliError("QUERY_VERIFICATION_ARGUMENTS_INVALID");
  const values = parseSavedConfiguration(await readRecord(args[0]!, 1048576));
  const infoText = decodeUtf8File(await readRecord(args[1]!, 65536));
  const setup = decodeUtf8File(await readRecord(args[2]!, 65536));
  const info = JSON.parse(infoText);
  const token = values.COMMAND_BRIDGE_BEARER_TOKEN;
  if (!token || info.schemaVersion !== 1 || info.installed?.sourceSha !== args[3] || info.partial ||
      info.service?.state !== "running" || info.service?.autoStart !== true || !setup.includes("Token is hidden.") ||
      infoText.includes(token) || setup.includes(token)) throw new CliError("QUERY_VERIFICATION_FAILED");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyQueries(process.argv.slice(2)).catch(error => { process.stderr.write(`CommandBridge query verification: ${readFailure(error)}\n`); process.exitCode = 1; });
}
