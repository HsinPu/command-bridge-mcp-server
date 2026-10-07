#!/usr/bin/env node

import type { CommandExecutor } from "./services/commandExecutor.js";
import { version } from "./version.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
    console.log(version);
    return;
  }
  if (args.length) {
    if (args[0] === "update") {
      console.error("Updates require the service-installed administration launcher. Linux: /usr/local/bin/command-bridge update; Windows: CommandBridgeMCP\\command-bridge.cmd update. npm installations are updated through npm.");
      process.exitCode = 2;
      return;
    }
    console.error("Usage: command-bridge [--version|-V] (no arguments starts the MCP server)");
    process.exitCode = 2;
    return;
  }
  const [{ StdioServerTransport }, { loadConfig }, { createCommandBridgeServer }, { CommandExecutor }, { startHttpTransport }, { permitsDiagnosticStartup }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"), import("./config/env.js"), import("./server.js"),
    import("./services/commandExecutor.js"), import("./transport/httpTransport.js"), import("./startupPolicy.js")
  ]);
  const config = loadConfig();
  const executor = new CommandExecutor(config);
  const readiness = await executor.readiness();
  if (!permitsDiagnosticStartup(readiness)) throw new Error("Startup dependency checks failed: " + Object.entries(readiness.checks).filter(([, ok]) => !ok).map(([name]) => name).join(", "));

  if (!readiness.ready) console.error("CommandBridge diagnostic-only startup: Audit unavailable; new operations remain blocked.");

  if (config.transport === "http") {
    const httpServer = await startHttpTransport(config, executor);
    console.error(
      "CommandBridge MCP listening on http://" +
        config.httpHost +
        ":" +
        config.httpPort +
        "/mcp"
    );
    registerShutdownHandlers(executor, () => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    return;
  }

  const server = createCommandBridgeServer(config, executor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  registerShutdownHandlers(executor, () => server.close());
  console.error("CommandBridge MCP running via stdio.");
}

function registerShutdownHandlers(executor: CommandExecutor, close: () => Promise<void>): void {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15_000);
    try { await executor.shutdown(); await close(); clearTimeout(deadline); process.exit(0); }
    catch { clearTimeout(deadline); process.exit(1); }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("CommandBridge MCP startup failed:", error);
  process.exit(1);
});
