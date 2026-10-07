import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { toErrorPayload } from "../errors/AppError.js";
import { DEFAULT_AUDIT_EVENT_LIMIT } from "../services/auditLog.js";
import { CommandExecutor } from "../services/commandExecutor.js";
import { getSystemInfo } from "../services/systemInfoService.js";

const shellSchema = z.enum(["bash", "sh", "powershell", "cmd"]);
const auditEventSchema = z.object({
  fileTransfer: z.object({ schemaVersion: z.literal(1), operation: z.enum(["upload", "download"]), path: z.string().nullable(), size: z.number().nullable(), sha256: z.string().nullable(), committed: z.boolean() }).optional(),
  schemaVersion: z.literal(1),
  event: z.literal("command_bridge.audit"),
  auditId: z.string(),
  timestamp: z.string(),
  phase: z.enum(["attempted", "blocked", "completed", "failed"]),
  command: z.string(),
  shell: shellSchema.nullable(),
  cwd: z.string().nullable(),
  executionMode: z.enum(["allowlist", "guarded", "unrestricted"]),
  source: z.enum(["http-bearer", "stdio"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  errorCode: z.string().nullable()
});

export function registerCommandBridgeTools(
  server: McpServer,
  config: AppConfig,
  executor: CommandExecutor
): void {
  server.registerTool("command_bridge_update", {
    title: "Update this CommandBridge service",
    description: "Request an independent managed update from the fixed verified CI channel. Enabled by default for service installations. Returns acceptance and a job ID, not installation success. The MCP connection may disconnect during restart; reconnect and query update status. No URL, shell, version or installer arguments are accepted.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (_request, extra) => { try { return toToolResult(await executor.updates.start(extra.signal)); } catch (error) { return toToolResult(toErrorPayload(error), true); } });
  server.registerTool("command_bridge_get_update_status", {
    title: "Get managed update status",
    description: "Read the root-managed update task record after reconnecting. Omit jobId to recover the latest accepted request. No installation logs, internal paths or secrets are returned.",
    inputSchema: z.object({ jobId: z.string().uuid().optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId }) => { try { return toToolResult(await executor.updates.status(jobId)); } catch (error) { return toToolResult(toErrorPayload(error), true); } });
  server.registerTool("command_bridge_upload_file", {
    title: "Upload file to transfer directory",
    description: "Upload a Base64 file into the dedicated transfer directory. Independently disabled by default. Single filenames only, at most 5 MiB, no overwrite, no execution or extraction.",
    inputSchema: { path: z.string().max(120), contentBase64: z.string().max(6990508), sha256: z.string().regex(/^[a-f0-9]{64}$/), overwrite: z.boolean().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async (request, extra) => { try { return toToolResult(await executor.files.upload(request, extra.signal)); } catch (error) { return toToolResult(toErrorPayload(error), true); } });
  server.registerTool("command_bridge_download_file", {
    title: "Download file from transfer directory",
    description: "Read a regular file from the dedicated transfer directory as Base64 with SHA-256. Independently disabled by default. Single filenames only and at most 5 MiB; no arbitrary host paths.",
    inputSchema: { path: z.string().max(120) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ path }, extra) => { try { return toToolResult(await executor.files.download(path, extra.signal)); } catch (error) { return toToolResult(toErrorPayload(error), true); } });
  server.registerTool(
    "command_bridge_get_system_info",
    {
      title: "Get CommandBridge Host Information",
      description:
        "Return operating-system information and the effective CommandBridge command policy.",
      inputSchema: {},
      outputSchema: {
        hostname: z.string(),
        platform: z.string(),
        release: z.string(),
        architecture: z.string(),
        uptimeSeconds: z.number().int(),
        cpuCount: z.number().int(),
        totalMemoryMb: z.number().int(),
        freeMemoryMb: z.number().int(),
        executionMode: z.enum(["allowlist", "guarded", "unrestricted"]),
        managedUpdate: z.object({ enabled: z.boolean(), serviceInstallationRequired: z.literal(true) }).optional(),
        fileTransfer: z.object({ uploadEnabled: z.boolean(), downloadEnabled: z.boolean(), maxBytes: z.number().int(), overwrite: z.literal(false) }).optional(),
        allowedShells: z.array(shellSchema),
        allowedCommands: z.array(z.string()),
        allowedRoots: z.array(z.string()),
        maxParallelCommands: z.number().int()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => toToolResult(getSystemInfo(config))
  );

  server.registerTool(
    "command_bridge_run_command",
    {
      title: "Run Host Command",
      description:
        "Run one command on this Linux or Windows host. Allowlist mode blocks shell control syntax and unconfigured commands. Guarded mode rejects recognizable deletion and system modification; arbitrary programs can still change host state.",
      inputSchema: {
        command: z.string().min(1).max(20_000).describe("Command text to execute."),
        shell: shellSchema.optional().describe("Shell to use. Defaults to the first allowed shell."),
        cwd: z.string().min(1).optional().describe("Working directory under an allowed root."),
        timeoutMs: z.number().int().min(1_000).optional().describe("Requested timeout in milliseconds.")
      },
      outputSchema: {
        ok: z.boolean(),
        shell: shellSchema,
        cwd: z.string(),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
        durationMs: z.number().int()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, shell, cwd, timeoutMs }, extra) => {
      try {
        return toToolResult(await executor.execute({ command, shell, cwd, timeoutMs }, extra.signal));
      } catch (error) {
        return toToolResult(toErrorPayload(error), true);
      }
    }
  );

  server.registerTool(
    "command_bridge_list_audit_events",
    {
      title: "List CommandBridge Audit Events",
      description:
        "Return recent CommandBridge command audit events. Commands are redacted; command output, bearer tokens, and environment values are never included.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of newest events to return. Defaults to 50.")
      },
      outputSchema: {
        events: z.array(auditEventSchema),
        hasMore: z.boolean()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ limit }) => {
      try {
        return toToolResult(await executor.listAuditEvents(limit ?? DEFAULT_AUDIT_EVENT_LIMIT));
      } catch (error) {
        return toToolResult(toErrorPayload(error), true);
      }
    }
  );
}

function toToolResult(structuredContent: unknown, isError = false) {
  const structured = toStructuredContent(structuredContent);
  return {
    isError,
    structuredContent: structured,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structured, null, 2)
      }
    ]
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
