# Guarded mode / 一般操作誤操作防護 (4.1.0)

`COMMAND_BRIDGE_EXECUTION_MODE=guarded` permits general Shell commands and literal pipelines/chains without allowlist command/argument profiles. It rejects recognizable direct deletion and system modifications before spawn. Existing sudo permissions, working-directory restrictions, timeouts, output limits, authentication and Audit remain in force. MCP self-protection applies in every mode; file transfer remains independently disabled until opted in.

**This is accident prevention, not a security sandbox.** Arbitrary programs, external scripts, aliases/functions loaded by a Shell, indirect service actions and filesystem races can bypass command-string inspection. No privilege broker or OS isolation is added. Passing the guard never proves a command harmless. Use a separate administrator terminal for maintenance.

## Modes / 三種模式

| Mode | Behavior |
| --- | --- |
| allowlist | Existing native executable/fixed Cmdlet policies with exact literal argv; remains the default. |
| guarded | General commands with bounded preflight checks for common destructive operations; ordinary work files may be overwritten. |
| unrestricted | Existing free Shell behavior, still subject to MCP self-protection. |

## Rules / 攔截規則

- Deletion: `rm`, `rmdir`, `unlink`, `shred`, `del`, `erase`, `rd`, `Remove-Item`/`ri`, `find -delete`, rsync deletion/remove-source options and robocopy `/MIR`, `/PURGE`, `/MOV`, `/MOVE`.
- System paths: recognizable writes, moves, permission changes and output redirections under `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/proc`, `/sys`, `/dev`; Windows SystemRoot, ProgramFiles and ProgramFiles(x86). Existing symlink/junction parents and destructive ancestor operations are checked. These checks do not make any directory read-only.
- Known package manager installation/removal/update operations; account/group/password changes; service start/stop/restart/configuration; network/firewall changes; disk formatting/partitioning/mount changes; reboot/shutdown; registry/task changes. Query variants such as `dnf list`, `systemctl status`, `firewall-cmd --list-all`, `Get-Service`, `reg query` remain available. Rules are command-specific, not a complete classification of all programs.
- Unknown complex syntax, unclosed quotes, expansion/substitution, background operators, here-documents and encoded Shell commands return `GUARDED_SYNTAX_UNSUPPORTED`. Literal pipe, `&&`, `||`, semicolon and output/input redirections are supported. Shell syntax support is deliberately bounded; not every Bash/PowerShell/cmd expression is accepted.

常見 sudo／絕對程式路徑包裝、引號、Windows 大小寫、相對路徑與連結都納入檢查。管線或串接中任何一段被拒絕，整個請求不執行。`sudo -n journalctl -n 10` 可通過此檢查；`sudo -n rm /tmp/a`、`sudo systemctl restart tomcat` 被拒絕。allowlist 與 unrestricted 的既有規則不變。

一般工作檔案可新增、複製、修改或覆寫。因此覆寫／截斷仍可能造成資料遺失，不等於「不會損壞檔案」。`mv` 在一般工作目錄仍可用。讀取系統檔案不因路徑本身被阻擋，但 OS 權限及 MCP 自身防護的保守判斷仍可能拒絕操作。複雜參數與廣泛 wildcard 可能造成誤擋。

External scripts such as `sudo bash /tmp/script.sh` are opaque and may still delete files or change the host. This release does not certify them safe. Direct variable expansion is rejected, but this does not prevent a program from computing a target internally.

## Choose mode / 選擇模式

From 4.1.2 the README one-command installers explicitly select guarded. For custom installer invocations, choose guarded with `--guarded` to the Linux bootstrap installation invocation (optionally `--run-as-installer` to keep the login account), or `-ExecutionMode guarded` to the Windows bootstrap invocation. `--guarded` and `--unrestricted` together are rejected. Windows explicitly supports `-ExecutionMode allowlist|guarded|unrestricted`; omitted mode preserves existing settings, with the existing fresh-install environment/default behavior retained.

Linux installation always selects the mode from this invocation: omitted mode selects allowlist; `--guarded` selects guarded; `--run-as-installer --unrestricted` selects unrestricted. Installation choices do not grant new sudo permissions. Windows LocalService does not acquire administrator privileges by changing mode.

已安裝主機可透過 SSH／主機管理員終端機修改既有設定，不需卸載重裝：

```dotenv
COMMAND_BRIDGE_EXECUTION_MODE=guarded
```

Linux 修改 `/etc/command-bridge/command-bridge.env` 後執行 `sudo systemctl restart command-bridge`；Windows 修改 `%ProgramData%\CommandBridgeMCP\command-bridge.env` 後，以管理員 PowerShell 執行 `Restart-Service CommandBridgeMCP`。不要經 MCP 修改自身設定。確認 `/ready`、真實 MCP 指令及 Audit 後再結束維護。

安裝切換沿用原有備份／回復流程，Token、其他設定、工作資料與傳輸設定保留。無法完成驗證時回復原設定與服務。固定 bootstrap 只能取得 CI 通過的 channel 版本；本地版本號不代表已發布。

## One-command installation / guarded 一鍵安裝

These optional commands require the 4.1.0 install channel to have been published after CI. They select guarded explicitly; the main README commands now make the same explicit mode selection.

Linux (sudo from the login account):

```bash
(script="$(mktemp)" && trap 'rm -f -- "$script"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "$script" && sudo bash "$script" --run-as-installer --guarded --print-codex-setup)
```

Windows (administrator PowerShell):

```powershell
$script = Join-Path $env:TEMP ("command-bridge-" + [guid]::NewGuid() + ".ps1"); try { Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.ps1" -OutFile $script; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ExecutionMode guarded -PrintCodexSetup; if ($LASTEXITCODE -ne 0) { throw "CommandBridge failed (exit $LASTEXITCODE)." } } finally { Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue }
```

## Error and Audit / 錯誤與操作紀錄

Rejected guarded requests return `DELETE_OPERATION_BLOCKED`, `SYSTEM_MODIFICATION_BLOCKED` or `GUARDED_SYNTAX_UNSUPPORTED`, with `rule` and `auditId` in the error payload. The Audit schemaVersion remains 1, accepts executionMode `guarded`, and records exactly attempted then blocked with the same ID/error code. No child process starts. Initial Audit failure prevents execution; terminal Audit failure withholds output. Tokens, stdout and stderr are not added to Audit.

MCP own-file rejection remains `SELF_MODIFICATION_BLOCKED`; see [self-protection](self-protection.md). See [validation status](validation-status.md) for local versus hosted deployment evidence.

## 4.1.1 parsing corrections / 參數修正

Download output checks include separated, compact short options (`curl -o/path`, `wget -O/path`, `wget -P/path`) and long options with `=`. Supported PowerShell write Cmdlets resolve named Path/LiteralPath/Destination/FilePath values regardless of order, including `-Path:value`. Copy-Item checks its destination; Move-Item checks both source and destination. Unknown/duplicate/ambiguous parameters return GUARDED_SYNTAX_UNSUPPORTED, including parameter abbreviations not explicitly supported. Named Value/Encoding and other supported non-path parameters are not mistaken for targets. These corrections do not extend the guard into a sandbox.

Since 4.1.2, reinstalling with the README command switches the saved mode to guarded on both platforms while preserving tokens and other settings. To select allowlist instead, remove --guarded from the Linux command or replace -ExecutionMode guarded with -ExecutionMode allowlist on Windows. Direct installer invocations without mode options and local stdio retain their previous defaults.
