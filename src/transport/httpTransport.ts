import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
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

  const app = express();
  if (config.allowedHosts.length) app.use(hostHeaderValidation(config.allowedHosts));
  else if (["127.0.0.1", "localhost", "::1"].includes(config.httpHost)) app.use(localhostHostValidation());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(["/mcp", "/ready"], (req, res, next) => {
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

  // Authenticate before allocating/parsing upload bodies; cap concurrent bodies.
  let requests = 0;
  app.use("/mcp", (_req, res, next) => {
    if (!config.fileTransfer?.upload && !config.fileTransfer?.download) { next(); return; }
    if (requests >= 4) { res.status(429).json({ error: "Server busy" }); return; }
    requests++; let released = false;
    const release = () => { if (!released) { released = true; requests--; } };
    res.once("finish", release); res.once("close", release); next();
  });
  app.use("/mcp", express.json({ limit: config.fileTransfer?.upload ? 4 * Math.ceil(config.fileTransfer.maxBytes / 3) + 4096 : 100 * 1024 }));

  app.get("/ready", async (_req, res) => {
    try {
      const readiness = await executor.readiness();
      res.status(readiness.ready ? 200 : 503).json(readiness);
    } catch { res.status(503).json({ ready: false }); }
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
      console.error("HTTP MCP request failed.");
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

  const bodyError: express.ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error?.status === 413 ? 413 : 400).json({ error: "Invalid or oversized request body" });
  };
  app.use(bodyError);

  return await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.httpPort, config.httpHost, () => resolve(listener));
    listener.requestTimeout = 30_000;
    listener.headersTimeout = 15_000;
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
