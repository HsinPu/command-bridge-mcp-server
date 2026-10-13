export const DEFAULT_AUDIT_TIMEOUT_MS = 30_000;
export const MAX_AUDIT_TIMEOUT_MS = 60_000;

export function parseAuditTimeout(value: unknown = DEFAULT_AUDIT_TIMEOUT_MS): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^\d+$/.test(value))) throw new Error("Invalid COMMAND_BRIDGE_AUDIT_TIMEOUT_MS: expected integer milliseconds from 1000 to 60000.");
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_AUDIT_TIMEOUT_MS) throw new Error("Invalid COMMAND_BRIDGE_AUDIT_TIMEOUT_MS: expected integer milliseconds from 1000 to 60000.");
  return timeout;
}

export function auditTimeout(config: { auditTimeoutMs?: number }): number { return parseAuditTimeout(config.auditTimeoutMs); }
// Each lifecycle can require an attempted and a terminal Audit operation.
export function auditRequestTimeout(timeout: number, commandMs = 0, operations = 2): number {
  return timeout * operations + commandMs + 20_000;
}
