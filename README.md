# CommandBridge MCP

Cross-platform Model Context Protocol server for policy-controlled command execution on Linux and Windows.

CommandBridge MCP is designed for machines that cannot or should not be managed through SSH. Install the server on the target host, connect through local stdio or a private Streamable HTTP endpoint, and let an MCP client run bounded commands.

> Status: early 0.1.0 implementation. Use on test machines before production.

## Design goals

- Linux and Windows support from one TypeScript codebase.
- No SSH dependency.
- Safe allowlist mode by default.
- Explicit opt-in for unrestricted shell execution.
- Bounded time, output size, working directories, environment variables, and parallelism.
- Structured MCP results for both host information and command execution.

## Architecture

~~~mermaid
flowchart LR
    AI["ChatGPT / Codex / MCP client"] -->|"stdio or private Streamable HTTP"| MCP["CommandBridge MCP"]
    MCP --> POLICY["Shell, command, path and limit policy"]
    POLICY --> HOST["Linux bash/sh or Windows PowerShell/cmd"]
~~~

Version 0.1 runs one MCP endpoint per host. A future gateway mode will let host agents initiate outbound connections to one central control plane.

## MCP tools

| Tool | Purpose |
|---|---|
| <code>command_bridge_get_system_info</code> | Return OS information and the effective execution policy. |
| <code>command_bridge_run_command</code> | Execute one bounded command and return exit code, stdout, stderr, timeout and truncation state. |

The command tool is annotated as destructive because unrestricted commands can change host state.

## Requirements

- Node.js 20 or newer
- npm
- At least one supported shell:
  - Linux: <code>bash</code> or <code>sh</code>
  - Windows: Windows PowerShell or <code>cmd.exe</code>
  - PowerShell 7 on Linux is supported through <code>pwsh</code>

## Install and build

~~~powershell
cd command-bridge-mcp-server
npm.cmd install
npm.cmd run build
~~~

## Local stdio usage

stdio is the default transport. An MCP client launches the process on the same host:

~~~json
{
  "mcpServers": {
    "command-bridge": {
      "command": "node",
      "args": [
        "C:\\path\\to\\command-bridge-mcp-server\\dist\\index.js"
      ],
      "env": {
        "COMMAND_BRIDGE_EXECUTION_MODE": "allowlist"
      }
    }
  }
}
~~~

## Remote HTTP usage without SSH

Create an environment file on the target host:

~~~dotenv
COMMAND_BRIDGE_TRANSPORT=http
COMMAND_BRIDGE_BEARER_TOKEN=replace-with-at-least-32-random-characters
COMMAND_BRIDGE_HTTP_HOST=0.0.0.0
COMMAND_BRIDGE_HTTP_PORT=8800
COMMAND_BRIDGE_ALLOWED_HOSTS=100.92.1.7,command-bridge.internal
COMMAND_BRIDGE_EXECUTION_MODE=allowlist
~~~

Then start the built server:

~~~powershell
npm.cmd start
~~~

The endpoint is <code>POST /mcp</code>. Every MCP request must include:

~~~http
Authorization: Bearer your-token
~~~

The unauthenticated <code>GET /health</code> endpoint returns only a basic health state.

Do not expose port 8800 directly to the public internet. Put it on a private network such as Tailscale, or behind an authenticated TLS reverse proxy. The built-in bearer token is an initial deployment control, not a replacement for network isolation and TLS.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| <code>COMMAND_BRIDGE_TRANSPORT</code> | <code>stdio</code> | <code>stdio</code> or <code>http</code>. |
| <code>COMMAND_BRIDGE_BEARER_TOKEN</code> | none | Required in HTTP mode; minimum 32 characters. |
| <code>COMMAND_BRIDGE_HTTP_HOST</code> | <code>127.0.0.1</code> | HTTP bind address. |
| <code>COMMAND_BRIDGE_HTTP_PORT</code> | <code>8800</code> | HTTP port. |
| <code>COMMAND_BRIDGE_ALLOWED_HOSTS</code> | none | Comma-separated Host header values; required for non-loopback binds. |
| <code>COMMAND_BRIDGE_EXECUTION_MODE</code> | <code>allowlist</code> | <code>allowlist</code> or <code>unrestricted</code>. |
| <code>COMMAND_BRIDGE_ALLOWED_SHELLS</code> | OS defaults | Comma-separated shell names. |
| <code>COMMAND_BRIDGE_ALLOWED_COMMANDS</code> | OS defaults | Comma-separated command names used in allowlist mode. |
| <code>COMMAND_BRIDGE_ALLOWED_ROOTS</code> | startup directory | Working-directory roots separated by the OS path delimiter. |
| <code>COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS</code> | <code>15000</code> | Default command timeout. |
| <code>COMMAND_BRIDGE_MAX_TIMEOUT_MS</code> | <code>60000</code> | Maximum requested timeout. |
| <code>COMMAND_BRIDGE_MAX_OUTPUT_CHARS</code> | <code>50000</code> | Combined stdout and stderr limit. |
| <code>COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS</code> | <code>2</code> | Per-process concurrency limit. |
| <code>COMMAND_BRIDGE_PASSTHROUGH_ENV</code> | none | Additional environment variable names inherited by child commands. |

Linux root lists use a colon:

~~~dotenv
COMMAND_BRIDGE_ALLOWED_ROOTS=/opt/apps:/var/log/myapp
~~~

Windows root lists use a semicolon:

~~~dotenv
COMMAND_BRIDGE_ALLOWED_ROOTS=C:\Apps;D:\Logs
~~~

## Execution policy

Allowlist mode:

- Accepts one simple command at a time.
- Rejects pipes, redirects, chaining, command substitution, and newlines.
- Requires the first command name to be configured.
- Still enforces allowed shells, working roots, timeout, output and concurrency limits.

Unrestricted mode:

~~~dotenv
COMMAND_BRIDGE_EXECUTION_MODE=unrestricted
~~~

This permits arbitrary shell syntax and can provide full control available to the operating-system account running CommandBridge. Use a dedicated low-privilege account and require human confirmation in the MCP client.

Child processes inherit only a small baseline environment plus explicitly named variables. The MCP bearer token is not inherited by commands.

## Installing when SSH is unavailable

You still need one initial management path to place and start CommandBridge:

- Synology DSM Container Manager or another container UI
- A cloud provider browser console
- Windows RDP, Task Scheduler, Intune, SCCM, or another software deployment system
- A hosting control panel with application deployment

A container controls only what is visible inside that container. Avoid mounting the host root or Docker socket unless that level of access is intentional.

## Similar GitHub projects

| Project | Approach | Difference from CommandBridge MCP |
|---|---|---|
| [girishsahu008/mcpshellserver](https://github.com/girishsahu008/mcpshellserver) | Local PowerShell plus remote Linux over SSH. | CommandBridge does not require SSH and applies bounded policies to both operating systems. |
| [CrazyMan28/vm-agent-mcp](https://github.com/CrazyMan28/vm-agent-mcp) | Cross-platform remote control over Tailscale, including desktop input and administrator access. | CommandBridge starts with command execution only and low-privilege, allowlist-first defaults. |
| [usepowershell/PoshMcp](https://github.com/usepowershell/PoshMcp) | Dynamically exposes PowerShell cmdlets and modules as MCP tools. | CommandBridge uses a small stable tool surface and also targets Linux shells. |
| [Areso/safe-ssh-mcp](https://github.com/Areso/safe-ssh-mcp) | Safety-oriented remote command execution through SSH. | CommandBridge targets environments where SSH is unavailable. |

The plain name CommandBridge is already used by unrelated GitHub projects, so this project should always be published and displayed as **CommandBridge MCP**. The intended repository name is **command-bridge-mcp-server**.

## Verification

~~~powershell
npm.cmd test
~~~

This builds the TypeScript project and runs the command-policy unit tests.

## Roadmap

- Background jobs with polling and cancellation
- Installers for Linux systemd and Windows services
- Structured audit logs with secret redaction
- Central gateway with agent-initiated outbound connections
- OAuth 2.1 for remote MCP clients
- Signed host enrollment and per-host authorization scopes

See [SECURITY.md](SECURITY.md) before deploying outside a development environment.
