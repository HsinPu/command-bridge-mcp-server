import "dotenv/config";
import { delimiter, resolve } from "node:path";
import { z } from "zod";
import type { ExecutionMode, ShellKind } from "../services/commandPolicy.js";

const rawEnvSchema = z.object({
  COMMAND_BRIDGE_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  COMMAND_BRIDGE_BEARER_TOKEN: z.string().min(32).optional(),
  COMMAND_BRIDGE_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  COMMAND_BRIDGE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8800),
  COMMAND_BRIDGE_ALLOWED_HOSTS: z.string().optional(),
  COMMAND_BRIDGE_EXECUTION_MODE: z.enum(["allowlist", "unrestricted"]).default("allowlist"),
  COMMAND_BRIDGE_ALLOWED_SHELLS: z.string().optional(),
  COMMAND_BRIDGE_ALLOWED_COMMANDS: z.string().optional(),
  COMMAND_BRIDGE_ALLOWED_ROOTS: z.string().optional(),
  COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  COMMAND_BRIDGE_MAX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  COMMAND_BRIDGE_MAX_OUTPUT_CHARS: z.coerce.number().int().min(1_000).default(50_000),
  COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS: z.coerce.number().int().min(1).max(32).default(2),
  COMMAND_BRIDGE_PASSTHROUGH_ENV: z.string().optional()
});

export interface AppConfig {
  transport: "stdio" | "http";
  bearerToken?: string;
  httpHost: string;
  httpPort: number;
  allowedHosts: string[];
  executionMode: ExecutionMode;
  allowedShells: ShellKind[];
  allowedCommands: Set<string>;
  allowedRoots: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputChars: number;
  maxParallelCommands: number;
  passthroughEnv: string[];
}

const shellKinds = new Set<ShellKind>(["bash", "sh", "powershell", "cmd"]);

export function loadConfig(): AppConfig {
  const result = rawEnvSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => issue.path.join(".") + ": " + issue.message)
      .join("; ");
    throw new Error("Invalid environment configuration: " + details);
  }

  const raw = result.data;
  const allowedHosts = parseCommaList(raw.COMMAND_BRIDGE_ALLOWED_HOSTS);
  const allowedShells = parseAllowedShells(raw.COMMAND_BRIDGE_ALLOWED_SHELLS);
  const allowedCommands = new Set(
    (raw.COMMAND_BRIDGE_ALLOWED_COMMANDS
      ? parseCommaList(raw.COMMAND_BRIDGE_ALLOWED_COMMANDS)
      : defaultAllowedCommands()
    ).map((command) => command.toLowerCase())
  );
  const allowedRoots = raw.COMMAND_BRIDGE_ALLOWED_ROOTS
    ? raw.COMMAND_BRIDGE_ALLOWED_ROOTS.split(delimiter).map((root) => resolve(root.trim()))
    : [resolve(process.cwd())];

  if (raw.COMMAND_BRIDGE_MAX_TIMEOUT_MS < raw.COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS) {
    throw new Error(
      "COMMAND_BRIDGE_MAX_TIMEOUT_MS must be greater than or equal to COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS."
    );
  }

  if (raw.COMMAND_BRIDGE_TRANSPORT === "http" && !raw.COMMAND_BRIDGE_BEARER_TOKEN) {
    throw new Error("COMMAND_BRIDGE_BEARER_TOKEN is required in HTTP mode.");
  }

  if (
    raw.COMMAND_BRIDGE_TRANSPORT === "http" &&
    !isLoopbackHost(raw.COMMAND_BRIDGE_HTTP_HOST) &&
    allowedHosts.length === 0
  ) {
    throw new Error(
      "COMMAND_BRIDGE_ALLOWED_HOSTS is required when HTTP_HOST is not a loopback address."
    );
  }

  if (allowedRoots.some((root) => root.length === 0)) {
    throw new Error("COMMAND_BRIDGE_ALLOWED_ROOTS contains an empty path.");
  }

  return {
    transport: raw.COMMAND_BRIDGE_TRANSPORT,
    bearerToken: raw.COMMAND_BRIDGE_BEARER_TOKEN,
    httpHost: raw.COMMAND_BRIDGE_HTTP_HOST,
    httpPort: raw.COMMAND_BRIDGE_HTTP_PORT,
    allowedHosts,
    executionMode: raw.COMMAND_BRIDGE_EXECUTION_MODE,
    allowedShells,
    allowedCommands,
    allowedRoots,
    defaultTimeoutMs: raw.COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: raw.COMMAND_BRIDGE_MAX_TIMEOUT_MS,
    maxOutputChars: raw.COMMAND_BRIDGE_MAX_OUTPUT_CHARS,
    maxParallelCommands: raw.COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS,
    passthroughEnv: parseCommaList(raw.COMMAND_BRIDGE_PASSTHROUGH_ENV)
  };
}

function parseAllowedShells(value: string | undefined): ShellKind[] {
  const configured = value
    ? parseCommaList(value)
    : process.platform === "win32"
      ? ["powershell", "cmd"]
      : ["bash", "sh"];

  for (const shell of configured) {
    if (!shellKinds.has(shell as ShellKind)) {
      throw new Error("Unsupported shell in COMMAND_BRIDGE_ALLOWED_SHELLS: " + shell);
    }
  }

  if (configured.length === 0) {
    throw new Error("COMMAND_BRIDGE_ALLOWED_SHELLS must include at least one shell.");
  }

  return configured as ShellKind[];
}

function defaultAllowedCommands(): string[] {
  if (process.platform === "win32") {
    return [
      "get-date",
      "get-computerinfo",
      "get-process",
      "get-service",
      "get-ciminstance",
      "hostname",
      "whoami",
      "systeminfo",
      "tasklist"
    ];
  }

  return ["uname", "hostname", "whoami", "uptime", "date", "df", "free", "ps", "pwd"];
}

function parseCommaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
