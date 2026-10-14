# Temporary command access / 臨時指令授權 (6.4.1)

Only an administrator on a service-installed host can run the local open/status/close commands. The grant applies to this entire service and every authenticated client during the window, not one Codex conversation. It changes command execution from the configured `allowlist` or `guarded` mode to `unrestricted` for a bounded period. It does not add sudo rights, enable file transfers, change working roots, skip Audit or edit permanent configuration. npm/stdio installations do not expose this feature.

授權適用於這台服務所有已驗證用戶端，不限定單一 Codex 對話。本機 access 命令僅供受管理服務的主機管理員使用：Linux 須以 root/sudo 執行；Windows 須使用已提升權限的管理員終端。臨時改為 unrestricted，不新增 sudo 權限、不開啟檔案傳輸、不放寬工作目錄，也不修改永久設定。若永久模式已是 unrestricted，open 會拒絕，close 不會改動永久模式。

## Commands / 指令

Linux:

```bash
sudo /usr/local/bin/command-bridge access open --minutes 5
sudo /usr/local/bin/command-bridge access status
sudo /usr/local/bin/command-bridge access close
```

Windows, from an elevated PowerShell:

```powershell
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" access open --minutes 5
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" access status
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" access close
```

Omitting `--minutes` uses 5 minutes. Accept only integer minutes from 1 through 60. A fresh administrator open request replaces/renews the temporary grant. Status prints the configured mode, effective mode, remaining seconds and an ISO UTC expiry; no Token or command output is printed. Close restores the configured mode immediately for new commands. Existing commands keep their original execution deadline and are not killed merely because temporary access ends.

未指定分鐘數時使用 5 分鐘，只接受 1–60 的整數。再次由管理員執行 open 可重新授權；status 顯示原模式、有效模式、剩餘秒數與 UTC 到期時間。close 或到期後，新指令立即恢復原模式；已啟動的指令仍遵守原逾時，不因授權到期被強制中斷。服務重啟、更新、重新安裝或主機重開後，舊授權不能再次生效。

## Storage, expiry and Audit / 紀錄、到期與稽核

The fixed `access-lease.json` sits alongside managed configuration: `/etc/command-bridge` or `%ProgramData%\CommandBridgeMCP`. Linux records are root-owned, readable by the policy-reader group and not writable by the service. Windows uses explicit Administrators/SYSTEM control with LocalService read access. Writes publish atomically; unsafe links/ownership/permissions are refused. The record contains bounded timestamps, UUIDs and the action, never a Token or shell template. Ordinary uninstall retains it with configuration; purge removes it with the safely validated configuration tree. No active service means no active grant.

Each service startup creates a new in-memory identity. A grant must match that identity; an expired or revoked grant cannot be replayed. Both wall-clock and monotonic deadlines prevent clock rollback from prolonging an active grant. Corrupt, unreadable or unsafe records restore the configured mode. Storage reads are bounded and share actual unfinished work; a timed-out read cannot later open access. Too many grants in one service lifetime fail closed until restart. New access requires successful Audit before activation; opening, closing, expiration and invalidation emit fixed management lifecycle events. Command Audit records the effective mode used; output withholding and initial-Audit failure rules remain unchanged.

每次啟動的識別不同，授權只屬於該次服務，不會因殘留檔案而在重啟後恢復。紀錄損壞、權限異常、讀取失敗或時鐘回退時恢復原限制。管理事件與指令沿用 Audit；開啟授權前須稽核成功。管理命令失敗不代表授權成功，也不應假定所有底層 I/O 已取消；請查 status，必要時 close。狀態與授權紀錄都不包含 Token。

The Host-protected HTTP `GET /access` endpoint (Bearer authentication for ordinary readers, or a scoped HMAC proof derived from the same Token for the local CLI) exposes only a boot identity and fixed status fields. It cannot create, extend or close a grant: only protected administrator-written storage can authorize a change. The local CLI contacts the saved local IP/loopback HTTP listener directly, bypassing proxy settings and ignoring a saved external HTTPS URL. It sends a random-challenge HMAC proof instead of the raw Token and verifies a signed response, so another process occupying the local port cannot receive the Token or forge status. localhost is pinned to loopback rather than DNS; other DNS listener names are refused. It refuses nonlocal listener addresses and does not accept user-supplied URLs, paths, modes or shell code. An unavailable listener is an error; there is no fallback to rewriting configuration or restarting the service.

## Boundary / 安全邊界

From 6.3.0 opening Audit can use two configured Audit budgets (30 seconds each by default). Each lease read still has a five-second response deadline and shares the actual unfinished read; it cannot grant later after timeout. Local status verification budgets include Audit confirmation, while the CLI has a hard cap based on the maximum allowed setting. The lease starts at its issued time, so slow Audit reduces its remaining window; a lease expiring during approval is never activated. This changes waiting, not storage permissions or SELinux handling.

6.3.0 起，開啟授權的兩筆 Audit 各使用設定時限，預設各 30 秒；授權檔讀取仍限五秒。CLI 等待涵蓋確認過程，但授權仍從申請時間起算；Audit 太慢而到期時拒絕生效，不延後或補發授權。此調整不改動 SELinux 工具呼叫或檔案權限。

Recognizable direct `access` CLI calls, literal sudo/shell wrappers and fixed implementation helpers are blocked through MCP in every execution mode, with attempted/blocked Audit. Protected-lease writes are also included in direct self-modification protection. This is the existing prevention of direct mistakes, not a sandbox against arbitrary scripts or a caller already able to execute arbitrary root code. A client with free shell commands and unrestricted passwordless sudo remains trusted; external root can change service files. During temporary access, deletion and system-management commands may run within the account's existing privileges.

MCP 不能直接呼叫 access 命令或固定管理 helper，也會攔截可辨識的授權檔修改。但這不是任意腳本或完整 root sudo 的隔離機制；仍須信任具備那些能力的用戶端。臨時 unrestricted 期間可能執行刪除及系統管理操作，實際權限仍由服務帳號及主機 sudo 政策決定。
