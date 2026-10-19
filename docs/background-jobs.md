# Background command jobs / 通用背景工作 (6.5.0)

Background jobs run finite, non-interactive commands without holding one MCP call open for their entire duration. They are available on Linux and Windows under the same service account and command policies as synchronous execution. No root worker or additional sudo permission is installed.

背景工作適用於編譯、測試、Docker 建置及其他有限時間指令。MCP 提交後取得工作 ID，斷線後已接受工作繼續執行；第一版不提供互動式終端、密碼輸入或永久服務。

## Enablement / 啟用

Managed installs and updates enable jobs when the setting is missing, append only missing job defaults and provision the fixed private storage. Explicit true/false values, existing root/timeouts and unrelated settings are preserved. npm/development defaults stay disabled. Administrator configuration uses these values; do not change them through MCP:

```dotenv
COMMAND_BRIDGE_JOBS_ENABLED=true
COMMAND_BRIDGE_JOBS_ROOT=/var/lib/command-bridge-jobs
COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS=1800000
COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS=3600000
```

On Windows, use the absolute `ProgramData\CommandBridgeMCP\jobs` path instead. Defaults are 30 minutes and a maximum of one hour. Both values accept integer milliseconds from 1000 to 86400000; the maximum must not be below the default. Requests exceeding the host maximum are rejected, not silently shortened. Synchronous command timeouts remain unchanged.

Linux upgrades: the installer backs up the original configuration before adding missing job settings, rolls back on verification failure, and is safe to repeat. It uses to provision the fixed directory with a root-owned 0755 parent, a selected numeric service-UID child at mode 0700 and host-policy SELinux labels. Select the existing account and desired execution mode explicitly when reinstalling. The installer refuses an existing directory with a different owner or unsafe permissions; it never recursively changes job data ownership. Account switching uses a different UID child. After verified switching, before deleting the unused dedicated account, its old child directory alone becomes root-owned and private to prevent UID reuse reading old output. Those archived records require administrator cleanup/purge and are not replayed by the new account. Custom locations must be provisioned separately and are not managed by installation/purge. The dedicated-account Linux unit also needs an administrator-managed ReadWritePaths override for a custom directory.

Windows upgrades: missing job defaults are added within the existing byte/ACL backup and rollback transaction; install/update prepares storage to provision the fixed jobs directory. It grants only SYSTEM, Administrators and LocalService access. Existing unsafe ACLs/reparse points fail validation rather than being silently accepted. Restart after successful preparation. The service must be able to write storage, while other ordinary accounts must not be able to read its output or replace its directory.

6.5.0 起，受管理安裝／更新會補齊缺少的背景工作欄位；明確停用不會被覆寫。原設定先備份，失敗回復，重複執行不重複加入。Linux 工作位置為 `/var/lib/command-bridge-jobs`，Windows 為 `ProgramData\CommandBridgeMCP\jobs`；一般卸載保留，完整清除前先檢查固定位置。自訂位置需由管理員自行管理。Linux 管理目錄內依服務 UID 分開保存；移除舊專用帳號前，只將其目錄本身封存為 root 私有，不遞迴修改內容。封存資料由管理員清除或 purge，不供新帳號重跑。

## Tools / 工具

| Tool | Input | Result |
| --- | --- | --- |
| `command_bridge_start_job` | `requestId`, `command`; optional `shell`, `cwd`, `timeoutMs`, `outputEncoding` | Accepted job metadata and `jobId` |
| `command_bridge_get_job` | `jobId` | State, times, mode, Audit ID/status, exit code and termination status |
| `command_bridge_list_jobs` | `offset` (default 0), `limit` (default 20; 1–50) | Metadata page and `nextOffset` |
| `command_bridge_read_job_output` | `jobId`, `stream` (`stdout`/`stderr`), `cursor`, `maxChars` (1–8000) | Text, next cursor, EOF and truncation flag |
| `command_bridge_cancel_job` | `jobId` | Cancellation/termination status; acceptance is not confirmed termination |

Example submission, provided the configured policy permits it:

```json
{
  "requestId": "8c2647c8-6aa3-4e22-bb74-99728192c008",
  "command": "docker build -t my-app .",
  "timeoutMs": 1800000
}
```

Generate a fresh UUID for each distinct operation. If submission times out or its response is lost, reuse the same UUID and identical parameters: it returns the retained job instead of rerunning it. Different parameters with the same UUID produce `JOB_REQUEST_CONFLICT`. Deduplication lasts only while the record is retained. After expiry, the same UUID can create a new job; check Audit and application state before repeating an operation with side effects.

提交超時不代表沒接受。應使用相同 `requestId` 找回，不要立即换一個 ID 重下。共享同一 Bearer Token 的用戶端可以讀取及取消同一服務的所有工作；工作 ID 不等於授權，也不提供對話／使用者隔離。

## Lifecycle / 生命週期

Jobs progress through `queued`, `starting`, `running`, `finalizing`, then `completed`, `failed`, `cancelled` or `timed_out`. `finalizing` includes terminal Audit and durable result publication. Unfinished records found on service startup become `interrupted`, with unknown Audit/termination status and withheld output. They are never automatically replayed.

Acceptance requires initial Audit, current policy validation and private durable storage. The service rechecks effective mode, shell, command arguments, real working directory and self-protection immediately before child startup. A mode change while queued produces `JOB_POLICY_CHANGED`; a temporary grant that expired cannot authorize queued work. Started work retains its original execution budget and mode.

Background and synchronous commands share `COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS` (default 2). Slots are reserved/converted/released once; process completion releases execution capacity before terminal Audit. Up to 10 admitted unfinished jobs and 100 retained records are permitted; output reservations and the total quota may lower effective queue capacity. A queued job expires after 10 minutes. Host resource exhaustion can still make commands slow.

每工作有同一 Audit ID 的 attempted 與唯一終結事件，透過選用 `job.schemaVersion=1`／`job.jobId` 關聯。程序成功不代表 Audit 或保存成功，必須核對狀態。服務崩潰可能留下只有 attempted 的紀錄；不補寫無法確認的完成結果。

## Output and storage / 輸出與保存

Running jobs expose metadata, elapsed time, raw pipe output byte count and last output activity, not live output text. Output is available only after terminal Audit and result storage succeed. Raw stdout/stderr are never written to Audit and may contain secrets; protected output is readable by authenticated clients and authorized host administrators.

Each job retains at most 5 Mi UTF-16 code units and 10 MiB of serialized output, combined across stdout/stderr. At the cap, `truncated=true`: the service continues draining pipes instead of killing the finite command. Exit success with truncated output remains a completed job. Invalid selected encoding still fails and withholds output. Page cursors use UTF-16 offsets and never split surrogate pairs; serialized pages stay below 64 KiB.

The store caps records at 100 MiB and removes completed records after 24 hours, during startup and periodic cleanup. It does not clear active jobs to reclaim space. Storage failure stops background admission and requests termination of running jobs; the failure remains latched until administrator repair and service restart. Actual timed-out I/O is tracked rather than abandoned or overlapped. A private owner record prevents two service processes sharing the same directory; stale PID checks never kill a process. A reused/live PID conservatively requires administrator investigation.

輸出是經指定編碼解碼的文字，不是檔案傳輸。不要用截斷或錯誤編碼的結果覆寫文件。輸出保留及檔案權限並不代表不可竄改；同帳號或完整 root sudo 的間接操作仍在既有安全邊界之外。

## Cancel, restart and update / 取消、重啟與更新

Queued cancellation removes work without child startup and records a blocked terminal event. Running cancellation first reports `terminationStatus=requested`; only confirmed process-tree/stream termination reports `confirmed`. Failure reports `unknown` and quarantines its shared command slot. Other free slots remain usable; exhausted capacity rejects commands with `COMMAND_TERMINATION_UNCONFIRMED` instead of pretending the service is shutting down. No external effects are claimed rolled back.

Linux retains process-group TERM/KILL escalation; Windows retains bounded process-tree termination. Killing a Docker/remote-job client does not guarantee the daemon/server stopped its work. Cancellation, timeout and service stop do not undo completed changes.

Shutdown remains bounded by 15 seconds. A host restart, terminal-admin update or reinstall can interrupt jobs; they do not survive a service restart as running work. MCP managed update rejects `UPDATE_JOBS_ACTIVE` while jobs are pending, including finalization or quarantined command capacity. Wait or cancel first. Normal uninstall preserves job records/output; `--purge` removes managed storage after safety checks.

第一版保障的是 MCP 用戶端斷線後持續執行，並非主機或服務重啟後接續。永久服務應由 systemd／Windows 服務等主機管理工具管理。無法確認終止時須由管理員檢查，不能只看 PID 或重下指令推定成功。

## Validation / 驗證

Behavior tests cover private storage/ACLs, command policy and self-modification rejection, independent timeout, shared capacity, cancellation, mode changes while queued, initial/terminal Audit failures, retry deduplication, interrupted recovery, output caps and real HTTP MCP disconnect/reconnect. Service installation verification additionally submits an allowed `hostname` job, checks its retained output and exact Audit lifecycle before accepting deployment. Local fixture success is not evidence of Oracle Linux Enforcing, Docker daemon cancellation or actual reboot behavior; see [validation status](validation-status.md).

## Unconfirmed termination / 終止未確認

Synchronous commands keep their existing output-limit termination contract. Background jobs truncate saved output and keep draining; use those tools for verbose builds instead of only increasing output limits.

A termination failure does not set service shutdown state. Diagnostics report `mode=degraded`, a quarantined count and safe execution evidence per Audit ID (trigger, effective limits, output counts, flags, duration, stage and classified error). The failed Audit retains actual timeout/truncation/duration; failed job records also retain safe execution evidence and real flags across reload. Records created before 6.5.0 without execution evidence retain their historical defaults; false flags alone cannot exclude an earlier timeout or output-limit trigger. The journal records bounded structured evidence without command output, environment, paths or raw exceptions. Readiness remains false while termination is unconfirmed.

Linux signals use the existing service identity. A sudo/root descendant may reject signals with EPERM; no general privileged killer, new sudo rule or automatic privilege escalation is installed. Administrators must investigate and stop any privileged descendants or external daemon work. The service periodically checks the original process handle, stream closure and process-group absence without sending more signals or killing saved/reused PIDs. Its slot recovers automatically only after confirmation; the original failed job remains a historical unknown result. While a group remains alive or cannot be inspected, capacity stays reserved. A fully occupied quarantine requires administrator action; diagnostics and Audit remain available. Service restart is a last resort and does not prove Docker daemon work stopped.

單一工作終止失敗不再使整個服務永久 stopping。未確認工作保留名額，診斷可查觸發原因、EPERM／期限／串流等分類；剩餘名額可繼續使用，全部占用則明確拒絕。Linux 不增加提權工具，sudo 啟動的 root 程序仍可能需要管理員處理。只有原程序退出、輸出串流結束且群組消失才自動釋放，不依保存 PID 發送訊號。原失敗紀錄保留 unknown，不將恢復容量當成原工作成功。
