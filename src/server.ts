import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config/env.js";
import { CommandExecutor } from "./services/commandExecutor.js";
import { registerCommandBridgeTools } from "./tools/commandBridgeTools.js";

export function createCommandBridgeServer(
  config: AppConfig,
  executor: CommandExecutor
): McpServer {
  const server = new McpServer({
    name: "command-bridge-mcp-server",
    version: "0.1.0"
  });

  registerCommandBridgeTools(server, config, executor);
  return server;
}
