import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/env.js";
import {
  createAuditEvent,
  type AuditEventList,
  type AuditLog
} from "../services/auditLog.js";
import { CommandExecutor } from "../services/commandExecutor.js";
import { registerCommandBridgeTools } from "./commandBridgeTools.js";

interface RegisteredTool {
  definition: { annotations?: Record<string, unknown> };
  handler: (argumentsValue: { limit?: number }) => Promise<{
    isError?: boolean;
    structuredContent: Record<string, unknown>;
  }>;
}

function createConfig(): AppConfig {
  return {
    transport: "stdio",
    bearerToken: undefined,
    httpHost: "127.0.0.1",
    httpPort: 8800,
    allowedHosts: [],
    executionMode: "allowlist",
    allowedShells: ["bash"],
    allowedCommands: new Set(["echo"]),
    allowedRoots: [process.cwd()],
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 60_000,
    maxOutputChars: 50_000,
    maxParallelCommands: 2,
    passthroughEnv: []
  };
}

test("audit query tool is read-only and returns the executor audit list", async () => {
  const event = createAuditEvent({
    auditId: "audit-tool",
    timestamp: "2026-07-29T00:10:00.000Z",
    phase: "completed",
    command: "echo safe",
    shell: "bash",
    cwd: process.cwd(),
    executionMode: "allowlist",
    source: "stdio",
    exitCode: 0
  });
  let requestedLimit = 0;
  const auditLog: AuditLog = {
    async write() {},
    async list(limit: number): Promise<AuditEventList> {
      requestedLimit = limit;
      return { events: [event], hasMore: false };
    }
  };
  const executor = new CommandExecutor(createConfig(), auditLog);
  const registered = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, definition: RegisteredTool["definition"], handler: RegisteredTool["handler"]) {
      registered.set(name, { definition, handler });
    }
  } as unknown as McpServer;

  registerCommandBridgeTools(server, createConfig(), executor);
  const tool = registered.get("command_bridge_list_audit_events");
  assert.ok(tool);
  assert.equal(tool.definition.annotations?.readOnlyHint, true);
  assert.equal(tool.definition.annotations?.destructiveHint, false);

  const result = await tool.handler({ limit: 1 });

  assert.equal(result.isError, false);
  assert.equal(requestedLimit, 1);
  assert.deepEqual(result.structuredContent, { events: [event], hasMore: false });
});


test("MCP Audit schema accepts 1,000, preserves default 50 and rejects 1,001 before backend access",async()=>{
 const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
 const {McpServer}=await import("@modelcontextprotocol/sdk/server/mcp.js");
 const {InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js");
 const seen:number[]=[];
 const audit:AuditLog={async write(){},async list(limit){seen.push(limit);return {events:[],hasMore:false}}};
 const cfg=createConfig(), executor=new CommandExecutor(cfg,audit);
 const server=new McpServer({name:"audit-cap",version:"test"}),client=new Client({name:"audit-client",version:"test"});
 registerCommandBridgeTools(server,cfg,executor);
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(b);await client.connect(a);
  for (const args of [{},{limit:1000}]) {
   const result=await client.callTool({name:"command_bridge_list_audit_events",arguments:args});
   assert.equal(result.isError,false);
  }
  const invalid=await client.callTool({name:"command_bridge_list_audit_events",arguments:{limit:1001}});
  assert.equal(invalid.isError,true);
  assert.deepEqual(seen,[50,1000]);
 } finally {await client.close();await server.close();await executor.shutdown();}
});
