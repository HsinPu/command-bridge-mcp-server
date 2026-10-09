# Local installation information / 本機安裝與連線資訊 (6.1.0)

These commands run in a host terminal and use the service installation's bundled Runtime. They do not start MCP, load its full policy/configuration, depend on Audit, contact GitHub, restart services, or write settings. npm/stdio installations return `SERVICE_INSTALLATION_REQUIRED` (or the npm entry's equivalent message); their existing no-argument MCP startup and version query remain unchanged.

這些命令在主機終端執行，使用服務安裝內附的 Runtime。查詢不啟動 MCP、不載入完整政策、不依賴 Audit、不連 GitHub、不重啟服務，也不寫入設定。npm／stdio 安裝不支援服務資訊查詢；原本無參數啟動 MCP 與版本查詢維持不變。

## Commands / 指令

Linux:

```bash
command-bridge info
command-bridge info --json
command-bridge setup
sudo command-bridge setup --show-token
command-bridge setup --codex-name cb_other --codex-url https://private.example/mcp
```

Windows PowerShell:

```powershell
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" info
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" info --json
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" setup
# Use an elevated PowerShell terminal for this line:
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" setup --show-token
& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" setup --codex-name cb_other --codex-url https://private.example/mcp
```

`info` and ordinary `setup` never intentionally print the saved Bearer Token. `setup` needs readable protected settings: use `sudo command-bridge setup` (still hidden) or an elevated Windows terminal when ordinary-user access is insufficient. `setup --show-token` requires Linux effective UID 0 or an elevated Windows administrator token, readable protected settings and a printable Token. It does not auto-elevate. Its complete copy block contains a secret: use it only in a trusted Codex task and do not publish or commit it. The output keeps the host-specific Token environment variable, connection collision warning and existing 20-second startup / 360-second tool budget.

`info` 與一般 `setup` 隱藏既有 Bearer Token。`setup` 仍需讀取受保護設定；一般帳號無權限時使用 `sudo command-bridge setup`（仍隱藏 Token）或管理員 PowerShell。`setup --show-token` 須由 Linux root 或已提升權限的 Windows 管理員執行，且設定可安全讀取；不會自動提權。完整複製區塊含秘密，只可交給受信任的 Codex 工作，不要公開或提交到 Git。連線名稱或 Token 環境變數已被其他主機使用時，改用未占用的名稱，不能覆蓋其他連線。

Overrides change only this query's output. Names follow `[a-z][a-z0-9_]{0,63}`. URLs must be HTTPS, end in `/mcp` (optional trailing slash), and contain no credentials, query or fragment. They do not change the listener, allowed Host, saved name, proxy, firewall or TLS. Installation still uses its existing `--codex-name` / `-CodexName` and `--codex-url` / `-CodexUrl` options to save these values.

查詢的 `--codex-name`／`--codex-url` 只改本次輸出。要儲存變更，仍使用安裝器的原有同名選項（Windows 為 `-CodexName`／`-CodexUrl`）。查詢不會修改 listener、Host、代理、防火牆或 TLS。

## Information and exit codes / 內容與退出碼

`info --json` has a fixed `schemaVersion: 1`. It reports:

| Field | Meaning / 說明 |
| --- | --- |
| `installed` | Installed package version, full source SHA and recorded Runtime version; no latest-version lookup. / 已安裝版本、完整 SHA、安裝紀錄的 Runtime 版本。 |
| `locations` | Selected release, configuration, client description and configured work roots. / 程式、設定、描述檔及工作目錄。 |
| `service` | Read-only service state, startup setting and account; unknown values are explicit. / 唯讀服務狀態、開機啟動設定及帳號。 |
| `executionMode` | Saved allowlist / guarded / unrestricted mode, not an execution permission grant. / 儲存的執行模式。 |
| `connection` | Listener URL, client URL/name, source, legacy fallback and loopback status. / listener 與給 Codex 的網址、名稱、來源及回退狀態。 |
| `tokenStatus` | `configured`, `missing` or `unavailable`; never the Token value. / 僅呈現有無或無法讀取。 |
| `audit` | Saved backend and expected location; `locationVerified: false`. / 後端及預期位置，不檢查可讀寫狀態。 |
| `fileTransfer`, `managedUpdateEnabled` | Saved enablement flags, not a readiness test. / 檔案傳輸及 MCP 更新開關。 |
| `partial`, `issues` | Fixed error categories for unreadable/invalid settings or unavailable service queries. / 權限、資料或服務查詢限制。 |

The Linux installer-account file Audit location is the fixed installer state directory. For other file-backend configurations, the query may report a null location rather than infer the service environment's data directory. `auto` describes the HTTP installation's platform-native backend. Service state alone does not prove readiness, working MCP/Audit, TLS, firewall access or remote reachability.

一般帳號可以取得可讀的安裝摘要；設定不可讀時，相關欄位為空並列出固定問題代碼，不能據此推定設定缺失。服務顯示 running 不代表 `/ready`、MCP／Audit 或遠端網路已驗證。這些查詢每次最多 5 秒、輸出最多 64 KiB；部署在讀取期間切換會要求重試，避免混用版本與 SHA。

- Exit `0`: complete local information or successful setup output.
- Exit `1`: partial info or a query failure; JSON partial info remains available when safe. `INSTALLATION_CHANGED` means retry after installation finishes.
- Exit `2`: invalid arguments; no path/source/configuration override is accepted.
- Exit `3`: this entry is not a supported managed service installation.

All errors use bounded fixed categories rather than raw configuration, command text or native error output. Windows service queries use a fixed protected PowerShell script and built-in modules; Linux uses fixed `/usr/bin/systemctl` properties. No new privileged reader or general sudo authorization is installed for these commands.

## Saved client description / 儲存的連線描述

| Platform | File / 路徑 |
| --- | --- |
| Linux | `/etc/command-bridge/client-setup.json`, root-owned `0640`, service read-only group. |
| Windows | `%ProgramData%\CommandBridgeMCP\client-setup.json`, protected administrator/SYSTEM owner and ACL, LocalService read-only. |

Example (no Token):

```json
{
  "schemaVersion": 1,
  "connectionName": "cb_oracle_prod",
  "urlMode": "explicit",
  "explicitUrl": "https://private.example/mcp",
  "advertisedHost": null
}
```

Listener-derived descriptions use `urlMode: "listener"`, `explicitUrl: null`. A wildcard IPv4 listener can save an installation-selected advertised address; queries never scan the network. Wildcard IPv6 falls back to IPv6 loopback. Precedence is output override, then saved description, then hostname/listener fallback. A missing description on an older installation warns that previous custom names/HTTPS URLs cannot be recovered; an invalid record is reported instead of reset silently. Repair it from an administrator terminal using a verified backup.

新安裝寫入描述檔，但不寫 Token。重裝／更新保留名稱、明確 HTTPS 網址與 wildcard 提供的位址；安裝器明確指定參數時才改儲存值，`RefreshNetwork` 更新安裝器管理的提供位址並保留 HTTPS URL。原資料未變時保留完整位元組（含 BOM／換行），切換失敗回復原始檔案與權限；Linux 同時修復／驗證 SELinux。回復不完整時保留私有資料、拒絕重啟並要求管理員處理。

Ordinary uninstall preserves this file with configuration, Token and data. `--purge` / `-Purge` removes it only after safe path/ownership checks. Do not edit it through MCP. The installer verifies actual `info --json` and hidden `setup` output before discarding upgrade backups; captured outputs stay in its private transaction directory.

## MCP boundary / MCP 邊界

Recognizable direct calls to info/setup, their JSON/Token variants, sudo/common literal shell wrappers and fixed implementation helpers are blocked in all execution modes before spawning a child. The result is `LOCAL_ADMIN_COMMAND_BLOCKED`, rule `local-admin-only` and an Audit ID, with attempted/blocked lifecycle events. Use [sanitized MCP diagnostics](diagnostics.md) for remote troubleshooting.

MCP 不能直接執行上述本機管理命令，包含 `unrestricted`。既有 `--version`、`update --check` 與固定 MCP 更新工具不受此新規則影響。此攔截防止可辨識的直接誤操作，不是任意 Shell／腳本的安全沙箱；仍需信任擁有自由指令及 sudo 權限的用戶端。不要把本機的含秘密設定輸出當成 MCP 診斷工具。
