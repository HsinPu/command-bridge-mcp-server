import { readFileSync } from "node:fs";
import { parse } from "dotenv";

// Parse data only. Never evaluate a saved environment file as Shell code.
try {
  const values = parse(readFileSync(process.argv[2]!, "utf8"));
  const mode = values.COMMAND_BRIDGE_EXECUTION_MODE ?? "allowlist";
  if (!["allowlist", "guarded", "unrestricted"].includes(mode)) throw new Error("Invalid saved execution mode");
  console.log(mode);
} catch {
  console.error("Cannot read a valid saved execution mode; inspect the configuration from an administrator terminal.");
  process.exitCode = 1;
}
