# Independent read-only MCP diagnostics (4.5.0)

`command_bridge_get_diagnostics` is enabled by default over stdio and authenticated Streamable HTTP. It does not use Audit writes/reads and cannot run maintenance, repair storage, edit configuration or restart a service. Earlier deployments need an upgrade before the tool exists; normal client tool discovery then exposes it. Existing tool names and request/result formats remain unchanged.

```json
{}
```

The default returns up to 20 recent command summaries. `{"limit":100}` requests the maximum; `{"auditId":"<exact-id>"}` filters a literal ID. The schema rejects other arguments, invalid bounds, slashes and query syntax. Audit IDs can come from the existing Audit records or the latest diagnostic summaries. File/update operations are not in this volatile command list; update job status remains available through its dedicated tool.

| Field | Meaning |
| --- | --- |
| `version`, `startedAt`, `observedAt`, `processUptimeSeconds` | This process's package version and timing, not a GitHub publication or reboot claim. |
| `accepting`, `mode` | `normal`, `diagnostic-only` after Audit fails, or `stopping`. |
| `activeCommands`, `maxParallelCommands` | Actual execution-slot usage. A finished process awaiting terminal Audit no longer occupies a command slot. |
| `audit.backend`, `audit.available` | Effective file/journal/eventlog backend and the runtime failure latch. |
| `audit.firstFailure` | First failure time, read/write operation, queued/backend/admission stage and a classified reason. Later rejected calls do not overwrite it. |
| `audit.pendingIo`, `audit.queued` | Outstanding backend promises and queued work; a timed-out underlying disk operation may still finish. This is not a complete OS process inventory; a rejected native helper can still be ending. |
| `recentRequests` | At most 100 volatile summaries: Audit ID, start time, phase, elapsed time when known, exit code, timeout and safe error code. No command text or output. |
| `probes`, `partial` | Fixed source status, probe observation time, safe metadata or unavailable reason. `pending` tracks unfinished underlying work; cached data may be older than the top-level observation time. |

The summary includes **no command text, cwd, stdout/stderr, environment/configuration, Token, raw exception/stack/log messages or complete internal paths**. Helpers parse only known typed diagnostic codes, not arbitrary lines with regex redaction. Storage names are resource categories; unavailable numeric measurements remain null rather than zero. OS metadata and log classification are best effort and not tamper-proof.

## Bounds and source selection

Each query has a five-second response budget and a 64 KiB response cap. Completed source results are cached for two seconds; concurrent queries share actual pending operations. A response deadline or caller cancellation does not release that work or create another helper. Cancelling one query does not cancel probes shared by other clients. Shutdown cancels native helpers and waits within the existing 15-second service budget. A stuck non-cancellable filesystem operation can still require a service restart.

The native helper has a 32 KiB output limit and a three-second Linux/four-second Windows termination deadline. Linux reads fixed service properties and at most 100 journal entries with a bounded buffer; Windows reads at most 64 KiB from each of the two active fixed WinSW files. Unknown messages are discarded. npm/local stdio executions outside the managed deployment do not provision or invoke a privileged native reader and report `notInstalled` for that source. Private file Audit has an independent metadata/read-access probe; it does not prepare directories, alter ACLs, write or read log contents.

Linux installs a root-owned no-argument reader plus an exact numeric service-UID sudo rule for either account mode. It accepts no unit, path, query or environment overrides and grants no general sudo/journal access. Windows stages a fixed script under the protected release and runs system PowerShell with standard directory variables and fixed built-in modules; it adds no elevation broker. See the platform guides for asset locations, rollback and removal.

## Audit failure and recovery

If configuration, policies, roots and shells pass but Audit fails during startup, the server can start in diagnostic-only mode. Existing Bearer Token and Host validation still apply. `/health` reports liveness; `/ready` remains 503. Commands, transfers and new update requests still require initial Audit, and captured command/download output still requires terminal Audit. No fallback execution backend or automatic Audit reset is introduced. The installer requires real readiness, hostname/Audit and managed-reader verification, so diagnostic-only startup cannot make a failed deployment appear successful.

Ask the connected client: 「請使用 command_bridge_get_diagnostics，查看首次 Audit 故障原因、尚未完成的 I/O 與最近指令摘要，不要執行修復指令。」 Inspect `noSpace`, `permissionDenied`, `helperTimeout`, `deadlineExceeded`, `queueFull` or `unknown` as categories, not proof of a particular root cause. Use a separate administrator terminal to verify host storage, access and fixed reader assets; restart after resolving the fault. The first fault and volatile command summaries reset on restart, while durable Audit retention is unchanged.

This tool cannot diagnose a stopped/unreachable server, blocked network or frozen event loop. It does not provide stdout/stderr history or a complete historical export. Continue using `command_bridge_list_audit_events` (default 50, maximum 1,000) for durable lifecycle records when that backend works, and administrator service logs when MCP itself is unavailable.
