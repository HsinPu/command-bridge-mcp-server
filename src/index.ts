#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { createCommandBridgeServer } from "./server.js";
import { CommandExecutor } from "./services/commandExecutor.js";
import { startHttpTransport } from "./transport/httpTransport.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const executor = new CommandExecutor(config);
  const readiness = await executor.readiness();
  if (!readiness.ready) throw new Error("Startup dependency checks failed: " + Object.entries(readiness.checks).filter(([, ok]) => !ok).map(([name]) => name).join(", "));

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
