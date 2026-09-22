# 1.0 migration and policy guide / 1.0 遷移與政策指南

## Compatibility / 相容性

The three MCP tools, `command`, `shell`, `cwd`, `timeoutMs`, and command result fields remain unchanged. Allowlist execution is intentionally stricter in 1.0: arguments must match an approved combination. Shell expansion, pipelines, redirection, control characters, globbing, and command substitution are rejected. Single/double quotes delimit literal arguments; backslashes are literal and are not shell escapes. Never switch to unrestricted as an automatic fallback.

三個 MCP 工具及原有輸入／結果欄位保留。1.0 的白名單模式改成精確參數政策；舊版可接受的自由參數可能被拒絕，因此升大版。單／雙引號可包住字面參數，反斜線不作 Shell 跳脫；控制語法、變數、萬用字元與命令替換一律拒絕。政策失敗不會自動切到 unrestricted。

Built-in commands accept `[]`. On Windows, `Get-CimInstance` with no arguments queries `Win32_OperatingSystem`; `-ClassName Win32_OperatingSystem` is also explicitly approved. To permit other native arguments, define a new custom command name rather than overriding a built-in profile.

## Custom native policies / 自訂原生程式政策

Set `COMMAND_BRIDGE_POLICY_FILE` to an absolute JSON path. Installers create an empty schemaVersion 1 template beside the environment configuration. Existing configuration files are preserved; add the setting yourself when migrating custom commands. Linux uses `/etc/command-bridge-mcp-server/policy.json`; Windows uses `%ProgramData%\CommandBridgeMCP\policy.json`.

Example Linux policy:

```json
{
  "schemaVersion": 1,
  "commands": [
    {
      "name": "inspect-disk",
      "platform": "linux",
      "shells": ["bash", "sh"],
      "executable": "/usr/bin/df",
      "allowedArgs": [[], ["-h"]]
    }
  ]
}
```

Enable it with `COMMAND_BRIDGE_ALLOWED_COMMANDS=hostname,inspect-disk`. Both `inspect-disk` and `inspect-disk -h` are accepted; `inspect-disk -h /other` is rejected. Windows uses platform `win32`, shells `powershell`/`cmd`, and an absolute `.exe` path, such as `C:\\Windows\\System32\\tasklist.exe` in JSON.

新增政策後，仍需在 `COMMAND_BRIDGE_ALLOWED_COMMANDS` 啟用該名稱。參數陣列逐項、區分大小寫比對，順序與數量都必須相同；無參數必須明列 `[]`。指令名稱為小寫 ASCII，呼叫時不區分大小寫。不得重複名稱或覆寫內建名稱。

Only native binaries for the current platform are accepted. Shells, known script hosts, and script files are rejected. Administrators must approve the binary's behavior and every argument combination; renamed interpreters or an unsafe administrator-supplied native program are not made safe by this mechanism. Keep the executable and its parent directories administrator-controlled.

The policy and containing directory must not be writable by the service identity. Linux installer defaults are root-owned policy `0640`, configuration directory `0750` with service-group traversal, and environment file `0600`. Windows grants LocalService read/execute access, not modification. Startup rejects a writable policy. Local stdio users who need custom policies must also use an administrator-managed location.

服務帳號不得寫入政策檔或替換其所在目錄的檔案。缺少、損壞、重複或沒有適用政策的自訂指令會讓啟動／升級前驗證失敗；管理員須先修正政策再重試。不要把未知的舊設定自動改成寬鬆規則。

## Installation channel / 安裝來源

The fixed bootstrap downloads `install-channel/channel.txt`: exactly two lines containing a full 40-character source SHA and a semantic package version. It downloads one source archive by SHA and executes that archive's platform installer. Node.js/WinSW versions remain independently pinned and checksum-verified. Git and preinstalled Node.js are unnecessary for remote installation.

Only successful main-push CI runs publish the channel, after both platforms pass unit/integration and service lifecycle checks. Publishing is serialized, checks commit ancestry, and uses a non-force push. Older results cannot replace newer verified commits. Missing/invalid channel metadata stops installation; there is no unverified-main fallback. Do not edit this branch manually to bypass checks.

安裝入口與程式版本已分開。升版只維護 package.json 與 lockfile 根套件版本，建置會產生 MCP 版本資訊。每個安裝保存版本、SHA 與 Runtime 資訊。Git tag 可留作歷史參考，不是安裝前置條件。本機 clone 安裝需先提交變更，以免同一 SHA 對應不同內容。

Uninstall uses the root/admin-controlled uninstaller saved by the installed release. Only when that file is absent does bootstrap download the current verified snapshot. Default uninstall keeps configuration/token/work data; explicit purge removes them. A failed migration is rejected before switching the running application.

## Audit backends / 稽核後端

`COMMAND_BRIDGE_AUDIT_BACKEND` accepts `auto`, `journal`, `eventlog`, or `file`. Unsupported platform combinations fail explicitly.

| Mode | auto backend |
| --- | --- |
| Local stdio | Private JSONL files |
| Linux HTTP | systemd journal |
| Windows HTTP | Application Event Log |

File storage is `$XDG_DATA_HOME/CommandBridgeMCP/audit` (otherwise `~/.local/share/CommandBridgeMCP/audit`) on Linux and `%LOCALAPPDATA%\CommandBridgeMCP\audit` on Windows. The active file is `events.jsonl`; `.1` through `.4` are rotated archives. Files are limited to 10 MiB each and protected for the current user. Use one server process per file-audit directory; this backend does not provide cross-process locking. OS log retention remains controlled by the host.

服務安裝明確設定 journal／eventlog；本機 stdio 不再依賴服務安裝資產。所有後端沿用相同事件及遮罩規則，不保存 stdout／stderr。Audit helper 五秒逾時，寫入失敗仍採拒絕執行／扣住輸出的策略。

## Readiness, shutdown, network / 就緒、停機與網路

`GET /health` remains the liveness endpoint. `GET /ready` requires the same bearer token as `/mcp`, returns boolean dependency checks, and uses 503 when unavailable; it intentionally verifies audit access and may add a readiness audit event. It does not expose file paths or secrets.

Installation verifies `/ready`, invokes `hostname` through the real MCP service, and queries the matching attempted/completed audit ID before deleting backup files. Ensure `hostname` remains enabled during installation. Command cancellation and shutdown stop admission, terminate process trees, and attempt the terminal audit write. Linux escalates TERM to KILL after two seconds; termination is bounded and failure is reported. Service shutdown has a 15-second limit.

Add `--refresh-network` (Linux) or `-RefreshNetwork` (Windows) to an installation to explicitly reselect the private IP and allowed Host. The token and other settings stay unchanged. Failure restores the previous configuration and release; success prints updated connection settings. The flag prints the token, so do not capture its output in public CI logs. It does not open firewall ports or create TLS.

一般重装保留既有 IP。只有明確要求 refresh-network 才重新選擇；DHCP／VPN 改變後可使用此選項。自動化健康檢查與服務啟動驗證不代表曾在使用者主機進行重開機測試。
