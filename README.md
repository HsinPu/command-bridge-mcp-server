<h1 align="center">CommandBridge MCP</h1>

<p align="center">
  <strong>Policy-controlled Linux and Windows command execution for Codex and other MCP clients.</strong>
</p>

<p align="center">
  <a href="https://github.com/HsinPu/command-bridge-mcp-server/actions/workflows/ci.yml"><img src="https://github.com/HsinPu/command-bridge-mcp-server/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/protocol-MCP-7f52ff" alt="Model Context Protocol"></a>
  <a href="#supported-hosts"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-2563EB" alt="Linux and Windows"></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-pre--1.0-F59E0B" alt="Pre-1.0"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#connect-codex">Connect Codex</a> ·
  <a href="#mcp-tools">MCP tools</a> ·
  <a href="docs/linux-systemd.md">Linux guide</a> ·
  <a href="docs/windows-service.md">Windows guide</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

> [!CAUTION]
> CommandBridge can execute operating-system commands. Start with <code>allowlist</code> mode, use a dedicated low-privilege service account, and keep remote HTTP access on a private authenticated network.

## Project status

CommandBridge MCP is pre-1.0 software for controlled environments. The pinned raw GitHub installation commands below target <code>v0.3.0</code>; use them only after that tag is published. A checked-out repository can be installed directly.

## Why CommandBridge?

CommandBridge is a cross-platform [Model Context Protocol](https://modelcontextprotocol.io/) server for inspecting a host and running policy-bounded commands when SSH is unavailable or intentionally excluded from the workflow.

| Need | CommandBridge approach |
|---|---|
| No SSH access | Use local <code>stdio</code> or private Streamable HTTP. |
| Safer first deployment | Default to simple, configured diagnostic commands in <code>allowlist</code> mode. |
| Linux and Windows hosts | Use the same MCP tool surface with platform-appropriate shells. |
| Traceable operations | Record a redacted audit lifecycle for every command attempt. |
| Controlled remote access | Require a bearer token for HTTP and place the listener behind private HTTPS. |

## Highlights

- **Cross-platform** — Linux supports <code>bash</code>, <code>sh</code>, and optional <code>pwsh</code>; Windows supports PowerShell and <code>cmd.exe</code>.
- **Policy-first execution** — limits shells, command names, working directories, timeouts, output size, inherited environment variables, and concurrency.
- **Audit trail** — records <code>attempted</code> plus one final <code>blocked</code>, <code>completed</code>, or <code>failed</code> event without command output or unredacted secrets.
- **Deployment assets** — provides a Linux systemd installer and an x64 Windows service installer using WinSW and <code>LocalService</code>.

## Quick start

### Linux systemd

From a checked-out repository on a supported glibc-based Linux host with systemd:

~~~bash
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
cd command-bridge-mcp-server
sudo bash scripts/linux-systemd/install.sh \
  --print-codex-setup \
  --codex-url "https://command-bridge.example.com/mcp"
~~~

The installer downloads a pinned Node.js runtime, builds and tests the source, creates the low-privilege <code>command-bridge</code> account, installs under <code>/opt</code>, enables the service, verifies <code>/health</code>, and prints a copy-ready Codex setup block.

Verify the service:

~~~bash
sudo systemctl status command-bridge-mcp-server --no-pager
curl -fsS http://127.0.0.1:8800/health
~~~

<details>
<summary>Install a published <code>v0.3.0</code> release without cloning</summary>

~~~bash
installer=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/install.sh -o "$installer"
sudo bash "$installer" --print-codex-setup --codex-url "https://command-bridge.example.com/mcp"
rm -f "$installer"
~~~

</details>

See the [Linux systemd guide](docs/linux-systemd.md) for prerequisites, rollback, upgrades, audit access, and safe uninstall procedures.

> [!NOTE]
> Synology DSM is not a systemd host. Use Container Manager or a DSM-specific package instead.

### Windows service

From an elevated PowerShell session in a checked-out repository:

~~~powershell
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
Set-Location command-bridge-mcp-server
.\scripts\windows\install.ps1 -PrintCodexSetup -CodexUrl "https://command-bridge.example.com/mcp"
~~~

The x64 installer verifies Node.js <code>v24.18.0</code> and WinSW <code>v2.12.0</code>, runs the test suite, registers the <code>CommandBridgeMCP</code> Application Event Log source, and starts the service as <code>NT AUTHORITY\LocalService</code>.

See the [Windows service guide](docs/windows-service.md) for host requirements, Event Viewer queries, rollback, and uninstall commands.

### Local development

~~~bash
git clone https://github.com/HsinPu/command-bridge-mcp-server.git
cd command-bridge-mcp-server
npm ci
cp .env.example .env
npm run build
npm start
~~~

The default transport is <code>stdio</code>. For Streamable HTTP, configure <code>COMMAND_BRIDGE_TRANSPORT=http</code> and a bearer token of at least 32 characters.

## Connect Codex

For a remote Codex client, expose the loopback listener through a private HTTPS route such as Tailscale Serve, Cloudflare Tunnel, or an authenticated reverse proxy.

> [!WARNING]
> CommandBridge's built-in HTTP listener is not TLS-enabled. Never expose port <code>8800</code> directly to the public internet.

The recommended path is to use <code>--print-codex-setup</code> during installation and paste the marked block into a trusted Codex task. It keeps the bearer token out of <code>config.toml</code> and uses an environment variable instead.

For manual setup, store the token as <code>COMMAND_BRIDGE_BEARER_TOKEN</code> on the Codex client and add:

~~~toml
[mcp_servers.command_bridge]
enabled = true
url = "https://command-bridge.example.com/mcp"
bearer_token_env_var = "COMMAND_BRIDGE_BEARER_TOKEN"
startup_timeout_sec = 20.0
tool_timeout_sec = 60.0
~~~

Restart Codex, open <code>/mcp</code>, and confirm that <code>command_bridge</code> is connected.

## How it works

~~~mermaid
flowchart LR
    client["Codex or MCP client"]
    transport{"Transport"}
    stdio["Local stdio"]
    http["Private Streamable HTTP"]
    auth["Bearer token and Host validation"]
    policy["Command policy and limits"]
    executor["Command executor"]
    audit["Redacted audit log"]
    host["Linux or Windows host"]

    client --> transport
    transport --> stdio --> policy
    transport --> http --> auth --> policy
    policy --> executor --> host
    executor --> audit
~~~

Each deployed host runs one MCP endpoint. A future gateway mode will coordinate multiple outbound-connected host agents.

## MCP tools

| Tool | Purpose | Safety behavior |
|---|---|---|
| <code>command_bridge_get_system_info</code> | Returns host information and the effective CommandBridge policy. | Read-only and idempotent. |
| <code>command_bridge_run_command</code> | Runs one command using the selected shell and working directory. | Enforces the configured policy; can change host state in <code>unrestricted</code> mode. |
| <code>command_bridge_list_audit_events</code> | Returns recent redacted audit events. | Read-only, idempotent, default limit 50, maximum 100. |

Example command request:

~~~json
{
  "command": "hostname",
  "shell": "bash",
  "cwd": "/var/lib/command-bridge-mcp-server/work",
  "timeoutMs": 15000
}
~~~

## Command audit log

Every <code>command_bridge_run_command</code> call writes an <code>attempted</code> event before process start, followed by exactly one terminal <code>blocked</code>, <code>completed</code>, or <code>failed</code> event.

- If the first audit write fails, CommandBridge does not start the command.
- If a terminal audit write fails, CommandBridge withholds captured command output.
- Events include an audit ID, time, phase, redacted command, shell, working directory, execution mode, source, exit code, duration, timeout/truncation state, and error code.
- Events never include <code>stdout</code>, <code>stderr</code>, bearer tokens, environment values, or the unredacted command.

On Linux, events are written as compact JSON to the service journal. On Windows, they are written to the Application Event Log under <code>CommandBridgeMCP</code>. The host controls retention. This is operational evidence, not a signed, hash-chained, or tamper-evident compliance ledger.

Use the read-only tool to inspect recent records:

~~~json
{ "limit": 50 }
~~~

## Uninstall

The Linux standard uninstall removes the service, application, Audit reader, and its restricted sudoers rule while preserving configuration, work data, and the low-privilege account for a later reinstall.

~~~bash
uninstaller=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "$uninstaller"
sudo bash "$uninstaller" --yes
rm -f "$uninstaller"
~~~

> [!CAUTION]
> A full purge permanently deletes the bearer token, configuration, work data, and service identity.

~~~bash
uninstaller=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "$uninstaller"
sudo bash "$uninstaller" --purge --yes
rm -f "$uninstaller"
~~~

For Windows, run <code>.\scripts\windows\uninstall.ps1 -Yes</code> from an elevated PowerShell session. Add <code>-Purge</code> to delete <code>%ProgramData%\CommandBridgeMCP</code>; use <code>-DryRun</code> to preview actions.

## Configuration and execution policy

Copy [.env.example](.env.example) for manual development. The most important settings are:

| Variable | Default | Purpose |
|---|---|---|
| <code>COMMAND_BRIDGE_TRANSPORT</code> | <code>stdio</code> | Selects <code>stdio</code> or <code>http</code>. |
| <code>COMMAND_BRIDGE_BEARER_TOKEN</code> | None | Required by HTTP mode; at least 32 characters. |
| <code>COMMAND_BRIDGE_EXECUTION_MODE</code> | <code>allowlist</code> | Selects <code>allowlist</code> or <code>unrestricted</code>. |
| <code>COMMAND_BRIDGE_ALLOWED_SHELLS</code> | OS defaults | Comma-separated permitted shells. |
| <code>COMMAND_BRIDGE_ALLOWED_COMMANDS</code> | OS defaults | Commands permitted in allowlist mode. |
| <code>COMMAND_BRIDGE_ALLOWED_ROOTS</code> | Startup directory | Allowed working-directory roots. |
| <code>COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS</code> | <code>15000</code> | Default command timeout. |
| <code>COMMAND_BRIDGE_MAX_OUTPUT_CHARS</code> | <code>50000</code> | Combined stdout and stderr ceiling. |
| <code>COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS</code> | <code>2</code> | Per-process command concurrency. |

<code>allowlist</code> mode rejects pipes, redirects, chaining, command substitution, and newlines. Use <code>unrestricted</code> only after reviewing the service account's operating-system permissions.

## Supported hosts

| Environment | Support |
|---|---|
| Manual development | Node.js 20 or later and npm |
| Linux runtime | <code>bash</code>, <code>sh</code>, and optional PowerShell 7 through <code>pwsh</code> |
| Linux installer | systemd, glibc, <code>x86_64</code> or <code>arm64</code>, Linux 4.18+, at least 400 MB under <code>/opt</code> |
| Windows runtime | Windows PowerShell and <code>cmd.exe</code> |
| Windows installer | Windows 10/11 or Windows Server x64, elevated PowerShell, bundled Node.js and WinSW |
| Alpine and musl Linux | Not supported by the systemd installer |

## Security model

Application policy is only one layer of defense.

- Keep <code>allowlist</code> mode unless unrestricted execution is explicitly required.
- Run CommandBridge under a dedicated non-administrator account.
- Use a unique bearer token per host and rotate it after suspected exposure.
- Keep HTTP private or behind authenticated TLS.
- Restrict allowed roots and inherited environment variables.
- Never place passwords, API keys, or private keys in command arguments.
- Do not add the Linux service account to <code>sudo</code>, <code>docker</code>, <code>adm</code>, or <code>systemd-journal</code> groups. The installer grants only one exact no-argument sudoers rule for its root-owned audit reader.

Read the complete [security policy](SECURITY.md) before deployment. Report vulnerabilities through a private [GitHub Security Advisory](https://github.com/HsinPu/command-bridge-mcp-server/security/advisories/new), not a public issue.

## Documentation

| Topic | Documentation |
|---|---|
| Linux installation, upgrades, audit access, and uninstall | [Linux systemd guide](docs/linux-systemd.md) |
| Windows service, Event Log, and uninstall | [Windows service guide](docs/windows-service.md) |
| Manual configuration reference | [.env.example](.env.example) |
| Security boundary and reporting | [SECURITY.md](SECURITY.md) |

## Development

~~~bash
npm ci
npm test
~~~

<code>npm test</code> compiles TypeScript and runs command-policy, audit lifecycle/redaction, MCP tool, Linux asset, uninstall asset, and Windows installer asset tests.

On Windows PowerShell, use <code>npm.cmd</code> when execution policy blocks <code>npm.ps1</code>.

~~~text
src/                         Application source
docs/                        Deployment guides
packaging/linux/             Fixed Linux audit reader
packaging/systemd/           Linux systemd unit
packaging/windows/           WinSW service definition
scripts/linux-systemd/       Linux installer and uninstaller
scripts/windows/             Windows installer, uninstaller, and Event Log helpers
~~~

## Roadmap

- Background jobs with polling and cancellation
- Central gateway with agent-initiated outbound connections
- OAuth 2.1 for remote MCP clients
- Signed host enrollment and per-host authorization scopes
- Signed prebuilt Linux release artifacts for offline installation

## Contributing

Issues and pull requests are welcome.

1. Open an [issue](https://github.com/HsinPu/command-bridge-mcp-server/issues) before a significant behavior or security-boundary change.
2. Create a focused branch.
3. Run <code>npm test</code>.
4. Open a pull request with the motivation, behavior change, and verification evidence.

## Project links

- [GitHub Actions](https://github.com/HsinPu/command-bridge-mcp-server/actions)
- [Issues](https://github.com/HsinPu/command-bridge-mcp-server/issues)
- [Releases and tags](https://github.com/HsinPu/command-bridge-mcp-server/tags)
- [Security advisories](https://github.com/HsinPu/command-bridge-mcp-server/security/advisories)
