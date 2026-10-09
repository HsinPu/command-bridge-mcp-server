import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CliError, createClientSetup, parseClientSetup, parseSavedConfiguration, renderCodexSetup, resolveConnection } from "./connectionSetup.js";
import { readRecord, readFailure } from "./managedFiles.js";

/** Installer-only helper. Its paths come from the protected installer, never MCP input. */
export async function runClientSetupInstaller(args: string[]): Promise<string> {
  const [operation, config, description] = args;
  if (operation === "validate" && args.length === 2) { parseClientSetup(await readRecord(config!, 16384)); return ""; }
  if (operation === "print" && args.length === 4 && ["hidden", "show"].includes(args[3]!)) {
    const values = parseSavedConfiguration(await readRecord(config!, 1048576));
    const saved = parseClientSetup(await readRecord(description!, 16384));
    const connection = resolveConnection(values, saved, hostname());
    if (values.COMMAND_BRIDGE_BEARER_TOKEN && JSON.stringify(connection).includes(values.COMMAND_BRIDGE_BEARER_TOKEN)) throw new CliError("CONNECTION_CONTAINS_SECRET");
    return renderCodexSetup(connection, args[3] === "show" ? values.COMMAND_BRIDGE_BEARER_TOKEN ?? "" : undefined);
  }
  if (operation !== "prepare" || args.length !== 7) throw new CliError("INSTALLER_HELPER_ARGUMENTS_INVALID", 2);
  const [, , , target, name, url, advertisedHost] = args;
  const values = parseSavedConfiguration(await readRecord(config!, 1048576));
  let previous = null, previousBytes: Uint8Array | undefined;
  try { previousBytes = await readRecord(description!, 16384); previous = parseClientSetup(previousBytes); }
  catch (error) { if (readFailure(error) !== "NOT_FOUND") throw error; }
  const record = createClientSetup(previous, hostname(), { name: name === "-" ? undefined : name, url: url === "-" ? undefined : url, advertisedHost: advertisedHost === "-" ? undefined : advertisedHost });
  parseClientSetup(Buffer.from(JSON.stringify(record)));
  if (values.COMMAND_BRIDGE_BEARER_TOKEN && JSON.stringify(record).includes(values.COMMAND_BRIDGE_BEARER_TOKEN)) throw new CliError("CONNECTION_CONTAINS_SECRET");
  resolveConnection(values, record, hostname());
  await writeFile(target!, previousBytes && JSON.stringify(record) === JSON.stringify(previous) ? previousBytes : JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClientSetupInstaller(process.argv.slice(2)).then(output => { if (output) process.stdout.write(output); })
    .catch(error => { process.stderr.write(`CommandBridge client setup: ${readFailure(error)}\n`); process.exitCode = error instanceof CliError ? error.exitCode : 1; });
}
