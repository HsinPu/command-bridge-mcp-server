import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../config/env.js";
import { createCommandBridgeServer } from "../server.js";
import type { CommandExecutor } from "../services/commandExecutor.js";

export async function startHttpTransport(
  config: AppConfig,
  executor: CommandExecutor
): Promise<Server> {
  const bearerToken = config.bearerToken;
  if (!bearerToken) {
    throw new Error("A bearer token is required for HTTP transport.");
  }

  const app = createMcpExpressApp({
    host: config.httpHost,
    ...(config.allowedHosts.length > 0 ? { allowedHosts: config.allowedHosts } : {})
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/mcp", (req, res, next) => {
    const authorization = req.headers.authorization;
    const suppliedToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    if (!tokensMatch(suppliedToken, bearerToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="command-bridge"');
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null
      });
      return;
    }

    next();
  });

  app.post("/mcp", async (req, res) => {
    const server = createCommandBridgeServer(config, executor);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.once("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("HTTP MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json(methodNotAllowed());
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json(methodNotAllowed());
  });

  return await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.httpPort, config.httpHost, () => resolve(listener));
    listener.once("error", reject);
  });
}

function tokensMatch(supplied: string, expected: string): boolean {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function methodNotAllowed() {
  return {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null
  };
}
