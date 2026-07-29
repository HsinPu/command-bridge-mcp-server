import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AppConfig } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import type { ExecutionMode, ShellKind } from "./commandPolicy.js";

export const AUDIT_EVENT_NAME = "command_bridge.audit";
export const AUDIT_SCHEMA_VERSION = 1;
export const DEFAULT_AUDIT_EVENT_LIMIT = 50;
export const MAX_AUDIT_EVENT_LIMIT = 100;

const LINUX_AUDIT_READER = "/usr/local/libexec/command-bridge-mcp-server/audit-reader";
const LINUX_JOURNAL_LINE_LIMIT = 1_000;
const WINDOWS_EVENT_LINE_LIMIT = MAX_AUDIT_EVENT_LIMIT + 1;
const MAX_AUDIT_READER_OUTPUT_BYTES = 4 * 1024 * 1024;
const shellKinds = new Set<ShellKind>(["bash", "sh", "powershell", "cmd"]);
const auditPhases = new Set<AuditPhase>(["attempted", "blocked", "completed", "failed"]);
const auditSources = new Set<AuditSource>(["http-bearer", "stdio"]);
const executionModes = new Set<ExecutionMode>(["allowlist", "unrestricted"]);

export type AuditPhase = "attempted" | "blocked" | "completed" | "failed";
export type AuditSource = "http-bearer" | "stdio";

export interface CommandAuditEvent {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  event: typeof AUDIT_EVENT_NAME;
  auditId: string;
  timestamp: string;
  phase: AuditPhase;
  command: string;
  shell: ShellKind | null;
  cwd: string | null;
  executionMode: ExecutionMode;
  source: AuditSource;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  timedOut: boolean;
  truncated: boolean;
  errorCode: string | null;
}

export interface CreateAuditEventInput {
  auditId?: string;
  timestamp?: string;
  phase: AuditPhase;
  command: string;
  shell?: ShellKind | null;
  cwd?: string | null;
  executionMode: ExecutionMode;
  source: AuditSource;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  errorCode?: string | null;
}

export interface AuditEventList {
  events: CommandAuditEvent[];
  hasMore: boolean;
}

export interface AuditLog {
  write(event: CommandAuditEvent): Promise<void>;
  list(limit: number): Promise<AuditEventList>;
}

export interface LinuxJournalAuditLogDependencies {
  writeLine?: (line: string) => Promise<void>;
  runReader?: () => Promise<string>;
}

export interface WindowsEventLogAuditLogDependencies {
  runScript?: (scriptName: WindowsAuditScriptName, eventJson?: string) => Promise<string>;
}

type WindowsAuditScriptName = "write-audit-event.ps1" | "read-audit-events.ps1";

export function createAuditLog(_config: AppConfig): AuditLog {
  return process.platform === "win32"
    ? new WindowsEventLogAuditLog()
    : new LinuxJournalAuditLog();
}

export function createAuditEvent(input: CreateAuditEventInput): CommandAuditEvent {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    event: AUDIT_EVENT_NAME,
    auditId: input.auditId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    phase: input.phase,
    command: redactCommand(input.command),
    shell: input.shell ?? null,
    cwd: input.cwd ?? null,
    executionMode: input.executionMode,
    source: input.source,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    durationMs: input.durationMs ?? null,
    timedOut: input.timedOut ?? false,
    truncated: input.truncated ?? false,
    errorCode: input.errorCode ?? null
  };
}

/**
 * Redacts values that commonly carry credentials before they can enter an audit event.
 * It intentionally has no opt-out: audit records must never contain a raw command secret.
 */
export function redactCommand(command: string): string {
  let redacted = command;

  // URL user-info: https://username:password@example.invalid/path
  redacted = redacted.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^@/\s]+@/g,
    "$1[REDACTED]@"
  );

  // Authorization headers and standalone bearer credentials.
  redacted = redacted.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");

  // Common HTTP header forms, including curl -H "X-Api-Key: value" and
  // Authorization: Basic values. The surrounding command syntax is retained.
  redacted = redacted.replace(
    /((?:(?:--?H|\/header)\s+)?["']?(?:authorization|x[-_]?api[-_]?key|api[-_]?key|token|secret|password|cookie|set-cookie)\s*:\s*)(?:(?:Bearer|Basic)\s+)?("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s'"]+)/gi,
    "$1[REDACTED]"
  );

  // JSON bodies such as {"token":"value"} or {"api-key": "value"}.
  redacted = redacted.replace(
    /((?:["']?)(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential(?:s)?|access[-_]?token|refresh[-_]?token)(?:["']?)\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,}&]+)/gi,
    "$1[REDACTED]"
  );

  // Shell and cmd environment assignments, including export NAME=value. Audit
  // records retain the variable name for command context but never its value.
  redacted = redacted.replace(
    /(^|[\s;&|])((?:export\s+|set\s+)?)([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gim,
    (_match, prefix: string, assignmentPrefix: string, key: string) =>
      prefix + assignmentPrefix + key + "=[REDACTED]"
  );

  // PowerShell environment assignments such as $env:COMMAND_BRIDGE_BEARER_TOKEN = '...'.
  redacted = redacted.replace(
    /(\$env:([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*)("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    (_match, assignment: string) => assignment + "[REDACTED]"
  );

  // Common flag forms: --token value, --password=value, /api-key value.
  redacted = redacted.replace(
    /((?:--?|\/)(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential(?:s)?|access[-_]?token|refresh[-_]?token))(\s+|=)("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    "$1$2[REDACTED]"
  );

  // Credential-bearing user flags are common even when no token-style key is present.
  redacted = redacted.replace(
    /((?:--user|-u)\s+)("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    "$1[REDACTED]"
  );

  // Windows setx SECRET value.
  redacted = redacted.replace(
    /(\bsetx\s+)([A-Za-z_][A-Za-z0-9_-]*)(\s+)("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)/gi,
    (match, prefix: string, key: string, separator: string) =>
      isSensitiveKey(key) ? prefix + key + separator + "[REDACTED]" : match
  );

  return redacted;
}

export function serializeAuditEvent(event: CommandAuditEvent): string {
  const normalized = normalizeAuditEvent(event);
  if (!normalized) {
    throw new Error("Refusing to serialize an invalid CommandBridge audit event.");
  }
  return JSON.stringify(normalized);
}

export function parseLinuxJournalLines(output: string): CommandAuditEvent[] {
  const events: CommandAuditEvent[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    // The installed reader uses `journalctl --output=cat`, so production
    // output is the audit JSON itself. Accept journal JSON as well to keep
    // parsing robust if a host administrator supplies archived journal output.
    const journalRecord = parseJsonRecord(line);
    const message = journalRecord?.MESSAGE;
    const event = parseAuditEventJson(typeof message === "string" ? message : line);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

export function parseWindowsEventLogLines(output: string): CommandAuditEvent[] {
  const events: CommandAuditEvent[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const event = parseAuditEventJson(line);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

export class LinuxJournalAuditLog implements AuditLog {
  private readonly writeLine: (line: string) => Promise<void>;
  private readonly runReader: () => Promise<string>;

  constructor(dependencies: LinuxJournalAuditLogDependencies = {}) {
    this.writeLine = dependencies.writeLine ?? writeLineToStderr;
    this.runReader = dependencies.runReader ?? runLinuxAuditReader;
  }

  async write(event: CommandAuditEvent): Promise<void> {
    try {
      await this.writeLine(serializeAuditEvent(event));
    } catch (error) {
      throw auditWriteError(error);
    }
  }

  async list(limit: number): Promise<AuditEventList> {
    const normalizedLimit = normalizeLimit(limit);
    let output: string;

    try {
      output = await this.runReader();
    } catch (error) {
      throw auditReadError(error);
    }

    const rawLineCount = output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    return limitEvents(
      parseLinuxJournalLines(output),
      normalizedLimit,
      rawLineCount >= LINUX_JOURNAL_LINE_LIMIT
    );
  }
}

export class WindowsEventLogAuditLog implements AuditLog {
  private readonly runScript: (scriptName: WindowsAuditScriptName, eventJson?: string) => Promise<string>;

  constructor(dependencies: WindowsEventLogAuditLogDependencies = {}) {
    this.runScript = dependencies.runScript ?? runWindowsAuditScript;
  }

  async write(event: CommandAuditEvent): Promise<void> {
    try {
      await this.runScript("write-audit-event.ps1", serializeAuditEvent(event));
    } catch (error) {
      throw auditWriteError(error);
    }
  }

  async list(limit: number): Promise<AuditEventList> {
    const normalizedLimit = normalizeLimit(limit);
    let output: string;

    try {
      output = await this.runScript("read-audit-events.ps1");
    } catch (error) {
      throw auditReadError(error);
    }

    const eventLines = output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    return limitEvents(
      parseWindowsEventLogLines(output),
      normalizedLimit,
      eventLines >= WINDOWS_EVENT_LINE_LIMIT
    );
  }
}

function limitEvents(
  events: CommandAuditEvent[],
  limit: number,
  readerMayHaveMore: boolean
): AuditEventList {
  const newestFirst = [...events].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp) || right.auditId.localeCompare(left.auditId)
  );

  return {
    events: newestFirst.slice(0, limit),
    hasMore: newestFirst.length > limit || readerMayHaveMore
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_EVENT_LIMIT) {
    throw new AppError(
      "AUDIT_LIMIT_INVALID",
      "Audit event limit must be an integer between 1 and 100.",
      "Choose a limit from 1 through 100."
    );
  }
  return limit;
}

function parseAuditEventJson(value: string): CommandAuditEvent | undefined {
  return normalizeAuditEvent(parseJsonRecord(value));
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAuditEvent(value: unknown): CommandAuditEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const shell = nullableShellKind(value.shell);
  const phase = stringValue(value.phase);
  const source = stringValue(value.source);
  const executionMode = stringValue(value.executionMode);
  const command = stringValue(value.command);
  const auditId = stringValue(value.auditId);
  const timestamp = stringValue(value.timestamp);

  if (
    value.schemaVersion !== AUDIT_SCHEMA_VERSION ||
    value.event !== AUDIT_EVENT_NAME ||
    !auditId ||
    !timestamp ||
    !command ||
    !phase ||
    !auditPhases.has(phase as AuditPhase) ||
    !source ||
    !auditSources.has(source as AuditSource) ||
    !executionMode ||
    !executionModes.has(executionMode as ExecutionMode) ||
    shell === undefined
  ) {
    return undefined;
  }

  const cwd = nullableString(value.cwd);
  const signal = nullableString(value.signal);
  const errorCode = nullableString(value.errorCode);
  const exitCode = nullableInteger(value.exitCode);
  const durationMs = nullableInteger(value.durationMs);

  if (
    cwd === undefined ||
    signal === undefined ||
    errorCode === undefined ||
    exitCode === undefined ||
    durationMs === undefined ||
    typeof value.timedOut !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    event: AUDIT_EVENT_NAME,
    auditId,
    timestamp,
    phase: phase as AuditPhase,
    command: redactCommand(command),
    shell,
    cwd,
    executionMode: executionMode as ExecutionMode,
    source: source as AuditSource,
    exitCode,
    signal,
    durationMs,
    timedOut: value.timedOut,
    truncated: value.truncated,
    errorCode
  };
}

function nullableShellKind(value: unknown): ShellKind | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && shellKinds.has(value as ShellKind)
    ? (value as ShellKind)
    : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "apikey" ||
    normalized === "authorization" ||
    normalized.startsWith("credential") ||
    normalized === "cookie" ||
    normalized === "session"
  );
}

function writeLineToStderr(line: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    try {
      process.stderr.write(line + "\n", (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function runLinuxAuditReader(): Promise<string> {
  return runFixedProcess(
    "/usr/bin/sudo",
    ["-n", LINUX_AUDIT_READER],
    { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" }
  );
}

function runWindowsAuditScript(
  scriptName: WindowsAuditScriptName,
  eventJson?: string
): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    return Promise.reject(new Error("Windows system root is unavailable."));
  }

  const powershell = resolve(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const scriptPath = resolve(process.cwd(), "scripts", "windows", "audit", scriptName);
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    ...(eventJson ? { COMMAND_BRIDGE_AUDIT_EVENT: eventJson } : {})
  };

  return runFixedProcess(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath
    ],
    environment,
    scriptName === "read-audit-events.ps1"
  );
}

function runFixedProcess(
  executable: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
  captureStdout = true
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    const child = spawn(executable, args, {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"]
    });

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error instanceof Error ? error : new Error("Fixed audit helper failed."));
    };

    child.once("error", fail);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_AUDIT_READER_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Fixed audit helper output exceeded its safe limit."));
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        fail(new Error("Fixed audit helper exited unsuccessfully."));
        return;
      }
      settled = true;
      resolvePromise(output);
    });
  });
}

function auditWriteError(cause: unknown): AppError {
  return new AppError(
    "AUDIT_LOG_WRITE_FAILED",
    "Command auditing is unavailable, so the command was not started or its result was withheld.",
    "Restore the configured audit sink before retrying the command.",
    { cause }
  );
}

function auditReadError(cause: unknown): AppError {
  return new AppError(
    "AUDIT_LOG_READ_FAILED",
    "CommandBridge could not read its audit records.",
    "Check the CommandBridge audit reader permissions and the host event log.",
    { cause }
  );
}
