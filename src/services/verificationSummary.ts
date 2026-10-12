const codes = new Set(["COMMAND_NOT_ALLOWED", "COMMAND_POLICY_MISSING", "SHELL_NOT_ALLOWED", "COMMAND_CANCELLED", "COMMAND_CONCURRENCY_LIMIT", "COMMAND_START_FAILED", "COMMAND_OUTPUT_ENCODING_FAILED", "AUDIT_LOG_WRITE_FAILED", "AUDIT_LOG_READ_FAILED", "LOCAL_ADMIN_COMMAND_BLOCKED", "SELF_MODIFICATION_BLOCKED", "DELETE_OPERATION_BLOCKED", "SYSTEM_MODIFICATION_BLOCKED", "WORKING_DIRECTORY_NOT_ALLOWED", "UNEXPECTED_ERROR"]);
/** Never expose verifier commands, output, messages, paths or credentials. */
export function commandVerificationSummary(result: unknown): string {
  const r = result as { isError?: unknown; structuredContent?: { ok?: unknown; exitCode?: unknown; timedOut?: unknown; truncated?: unknown; error?: { code?: unknown } } } | null;
  const v = r?.structuredContent;
  const code = typeof v?.error?.code === "string" && codes.has(v.error.code) ? v.error.code : "UNKNOWN";
  const exit = typeof v?.exitCode === "number" && Number.isSafeInteger(v.exitCode) && v.exitCode >= -2147483648 && v.exitCode <= 4294967295 ? v.exitCode : "unknown";
  return `VERIFIER_COMMAND_FAILURE code=${code} error=${r?.isError === true ? 1 : 0} ok=${v?.ok === true ? 1 : 0} exit=${exit} timeout=${v?.timedOut === true ? 1 : 0} truncated=${v?.truncated === true ? 1 : 0}`;
}
