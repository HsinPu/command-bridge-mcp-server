#!/usr/bin/env node

import type { Server } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/env.js";
import { createCommandBridgeServer } from "./server.js";
import { CommandExecutor } from "./services/commandExecutor.js";
import { startHttpTransport } from "./transport/httpTransport.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const executor = new CommandExecutor(config);

  if (config.transport === "http") {
    const httpServer = await startHttpTransport(config, executor);
    console.error(
      "CommandBridge MCP listening on http://" +
        config.httpHost +
        ":" +
        config.httpPort +
        "/mcp"
    );
    registerShutdownHandlers(httpServer);
    return;
  }

  const server = createCommandBridgeServer(config, executor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("CommandBridge MCP running via stdio.");
}

function registerShutdownHandlers(httpServer: Server): void {
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("CommandBridge MCP startup failed:", error);
  process.exit(1);
});
