# Command preflight self-protection / 指令誤操作攔截 (4.0.0)

CommandBridge checks commands before starting a child process. This guard is always applied to `allowlist`, `guarded` and `unrestricted`. It does **not** change the host's sudo policy, replace sudo with a broker, or enable `NoNewPrivileges`. Normal unrestricted commands and existing noninteractive sudo permissions remain available.

The guard rejects **recognizable direct attempts** to change CommandBridge's own files, with `SELF_MODIFICATION_BLOCKED`. The existing command result interface is unchanged; rejected requests record `attempted` then exactly one `blocked` event using the same Audit ID. No command process is started. Initial Audit failure still prevents execution; command output is not placed in Audit.

## Protected targets / 保護範圍

- The running application directory, the configured policy file, and an explicit `DOTENV_CONFIG_PATH` other than `/dev/null`.
- Linux: `/etc/command-bridge`, `/usr/local/lib/command-bridge`, `/opt/command-bridge`, the fixed Audit helper directory and sudoers file, and the main systemd unit. Legacy `command-bridge-mcp-server` application/configuration/unit paths remain protected.
- From 4.6.1, Linux's fixed `/usr/local/lib/command-bridge.migration-backup`, `/opt/command-bridge.migration-backup` and `/opt/command-bridge-mcp-server.migration-backup` are also protected from recognizable direct writes/deletion. Read access remains available; similarly named unrelated directories are not matched.
- Windows: `%ProgramFiles%\CommandBridgeMCP`, `%ProgramData%\CommandBridgeMCP\command-bridge.env`, and `policy.json`. Work and transfer directories are not made read-only by this guard.
- Recognizable service configuration changes naming `command-bridge`, `command-bridge-mcp-server` or `CommandBridgeMCP`.

Checks include normalized relative paths, platform separators, Windows case-insensitive matching and existing symlink/junction targets. For a destination that does not exist yet, the nearest existing parent is resolved. Direct operations on an ancestor directory are also rejected, to catch moving/deleting a containing directory. The guard does not change ownership or mount permissions.

## Examples / 範例

Recognizable direct writes are blocked:

```sh
sudo -n rm -- /etc/command-bridge/policy.json
sudo sed -i 's/allowlist/unrestricted/' /etc/command-bridge/command-bridge.env
echo changed > /etc/command-bridge/command-bridge.env
sudo systemctl edit command-bridge.service
```

Other operations retain their existing command policy and OS permissions:

```sh
sudo -n id -u
sudo -n rm -- /tmp/pdks.jar
cat /etc/command-bridge/policy.json
sudo systemctl restart tomcat
```

「可通過此攔截」不代表一定執行成功：allowlist 仍可能拒絕指令，檔案權限或主機 sudo 政策仍可能拒絕操作。使用 SSH／主機管理員終端機維護 CommandBridge 自身設定，不經 MCP 指令工具。固定 bootstrap 安裝／更新入口保持不變。

## Limits / 明確限制

**This is accident prevention, not reliable containment of arbitrary root code.** It uses bounded command tokenization and regular expressions for common mutation commands, redirections, wrappers and literal nested Shell commands. It does not fully interpret Bash, PowerShell or cmd syntax.

External scripts, variable/substitution expansion, encoded commands, arbitrary program internals and privileged external services may bypass it. For example, `sudo bash /tmp/script.sh` and `sudo tee "$TARGET"` cannot be proven safe by inspecting the submitted command string. Passing the guard never means a command is harmless. A symlink may also change after the preflight check; there is no filesystem race-proof enforcement for unrestricted execution.

Conservative matching can reject harmless operations, including copying a protected source to another directory, broad wildcard paths or complex command syntax. Common chmod/chown modes, sed/perl expressions, PowerShell value parameters and descriptor duplication are distinguished to reduce false positives. Remaining ambiguous cases should be run from a separate administrator terminal; there is no switch to turn the guard into a claim of full security.

The guard neither blocks all deletion nor makes unrestricted a sandbox. Keep the existing low-privilege/Token/network practices. File upload/download have their own independent directory and permission controls; see [file transfer](file-transfer.md).

## Migration / 3.x → 4.0

Previously valid unrestricted commands that directly modified these targets now fail before execution. Move those maintenance operations to a separate administrator terminal. No MCP tool is renamed, no sudoers policy is added, and no service-account mode is changed. Existing configuration, Token, command policies, work data and transfer settings remain preserved by the installers. Indirect attempts are outside this guard's guarantee; do not describe this release as preventing every possible self-modification.
