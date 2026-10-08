import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { startHttpTransport } from "./httpTransport.js";
import { CommandExecutor } from "../services/commandExecutor.js";
import type { AppConfig } from "../config/env.js";

test("HTTP health, readiness and real MCP initialize accept canonical hosts and reject untrusted hosts", { timeout: 20_000 }, async () => {
  const config: AppConfig = { transport: "http", bearerToken: "test-token-".repeat(4), httpHost: "127.0.0.1", httpPort: 0,
    allowedHosts: ["Bridge.INTERNAL:8800", "127.0.0.1:8800", "[::1]:8800"], executionMode: "unrestricted",
    allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(), allowedRoots: [process.cwd()],
    defaultTimeoutMs: 15_000, maxTimeoutMs: 15_000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] };
  const executor = new CommandExecutor(config, { async write() {}, async list() { return { events: [], hasMore: false }; } });
  const server = await startHttpTransport(config, executor);
  const call = (path: string, host: string, token = true) => new Promise<{status: number; body: any}>((resolve, reject) => {
    const body = path === "/mcp" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "host-test", version: "1" } } }) : undefined;
    const req = request({ hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path,
      agent: false, method: body ? "POST" : "GET", headers: { Host: host, ...(token ? { Authorization: `Bearer ${config.bearerToken}` } : {}),
        ...(body ? { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } : {}) } }, response => {
      let data = ""; response.setEncoding("utf8"); response.on("data", chunk => data += chunk);
      response.on("end", () => { try { resolve({ status: response.statusCode!, body: data ? JSON.parse(data) : null }); } catch(error) { reject(error); } }); response.on("error", reject);
    }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Host test request timed out"))); req.end(body);
  });
  try {
    for (const host of ["BRIDGE.INTERNAL:8800", "bridge.internal:9900", "bridge.internal:80", "127.0.0.1:8800", "[::1]:8800", "[0:0:0:0:0:0:0:1]:8800"]) {
      assert.equal((await call("/health", host)).status, 200);
      const ready = await call("/ready", host); assert.equal(ready.status, 200); assert.equal(ready.body.ready, true);
      const mcp = await call("/mcp", host); assert.equal(mcp.status, 200, JSON.stringify({ host, mcp })); assert.ok(mcp.body?.result?.serverInfo, JSON.stringify({ host, mcp }));
    }
    for (const path of ["/health", "/ready", "/mcp"]) assert.equal((await call(path, "untrusted.internal:8800")).status, 403);
    for (const host of ["bridge.internal/path", "user@bridge.internal", "::1"]) assert.equal((await call("/mcp", host)).status, 403);
    for (const path of ["/ready", "/mcp"]) assert.equal((await call(path, "bridge.internal:8800", false)).status, 401);
  } finally { await executor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
