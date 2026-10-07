# Windows service installation

Version 2.0.0 changes Linux service and installation path names only. The current package is 4.4.3; Windows keeps the `CommandBridgeMCP` service and its existing paths. The 1.0.5 startup diagnostics still report dependency/error categories, child-process/listener presence and bounded startup-log excerpts when health validation fails. They mask the configured bearer token and credential fields, skip Audit payloads and never dump configuration or environment values. Downloads suppress PowerShell progress rendering and still verify checksums.

The local health probe bypasses Internet proxy/WPAD settings and uses the configured allowed Host. It supports IPv4 and IPv6 listeners; this does not create firewall rules or bypass bearer authentication on MCP/readiness endpoints.

Audit helpers receive only standard Windows directory variables and load fixed built-in PowerShell modules, without inheriting arbitrary environment secrets or external module paths. Their five-second deadline remains unchanged. Startup diagnostics include rotated log files because WinSW restarts can leave the current error log empty.

The Windows build compiles the fixed directory-lease native interface into `dist/windows-directory-lease.dll` before tests and deployment. File transfers load that installed assembly instead of compiling during a request; a missing or invalid assembly fails closed. The five-second lock readiness deadline remains unchanged. A failed native build stops installation before service activation.

The Windows installer deploys CommandBridge as a WinSW-managed Windows service named <code>CommandBridgeMCP</code>. The service runs as the low-privilege <code>NT AUTHORITY\LocalService</code> account, not as LocalSystem.

## Supported hosts

- Windows 10 or Windows 11 x64
- Windows Server x64
- Elevated Windows PowerShell
- Outbound HTTPS access to GitHub, Node.js, and the npm registry during installation

ARM64 is intentionally deferred until a stable compatible service wrapper is selected.

## Install the latest verified source

No clone, Git, or preinstalled Node.js is required. The fixed bootstrap selects a main commit only after CI succeeds. Open Windows PowerShell as administrator and paste:

~~~powershell
$installer = Join-Path $env:TEMP ("command-bridge-" + [guid]::NewGuid() + ".ps1"); try { Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.ps1" -OutFile $installer; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ExecutionMode guarded -PrintCodexSetup; if ($LASTEXITCODE -ne 0) { throw "Installation failed (exit $LASTEXITCODE)." } } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
~~~

Download failures stop before execution. The temporary installer is removed on success or failure, and a nonzero installer exit code is reported as an error. Execution-policy bypass is limited to the child process. Without a URL, a fresh install selects a private IPv4 address (preferring a default-route interface), sets the listener and allowed Host, and prints `http://<IP>:<port>/mcp`. It accepts RFC1918 and 100.64.0.0/10 addresses (including Tailscale), falling back to `127.0.0.1` for local-only use if none is found. The command explicitly selects guarded on new installs/reinstalls; existing tokens and other configuration are preserved; the output uses the saved listener host and port. A wildcard IPv4 listener uses the detected private IP; wildcard IPv6 uses IPv6 loopback for local setup.

Add `-CodexUrl "https://your-private-host/mcp"` to use an existing HTTPS route; a fresh install then defaults to loopback. Explicit `COMMAND_BRIDGE_HTTP_HOST` and `COMMAND_BRIDGE_HTTP_PORT` override detection. A concrete non-loopback host is also used as the allowed Host unless separately configured; wildcard binds still require an explicit allowed Hosts list. The installer does not provision HTTPS or a tunnel.

The printed Codex block suggests a client connection name based on the Windows computer name, such as `[mcp_servers.cb_twtpelplmap06d]`, and a matching user environment variable, such as `CB_TWTPELPLMAP06D_TOKEN`. Add `-CodexName cb_windows_prod` to the one-command installation when you want a stable, explicit client alias. A name must start with a lowercase letter and contain only lowercase letters, digits or underscores, up to 64 characters. This option affects only the printed Codex setup, not the `CommandBridgeMCP` service or MCP tool names. It also implies setup output.

Paste the complete setup block into a trusted Codex task on the client. Before changing the user-level `~/.codex/config.toml` or user environment, check whether the suggested connection name or token variable already belongs to another host. If so, choose an unused name and its uppercase `<NAME>_TOKEN` variable, preserving the existing connection and token. Store each host's bearer token in its own user environment variable and reference it through `bearer_token_env_var`; do not put the token directly in TOML. The installer runs on the server host and cannot inspect the Codex client's settings, so this collision check happens when applying the block. Two hosts with the same computer name may need explicit distinct aliases.

For development, use a clean committed Git checkout, open an elevated PowerShell session, and run:

~~~powershell
Set-Location C:\path\to\command-bridge-mcp-server
.\scripts\windows\install.ps1 -PrintCodexSetup -CodexUrl "https://command-bridge.example.com/mcp"
~~~

The installer:

1. Requires an administrator session and x64 Windows.
2. Uses the complete source archive selected by the CI channel; a local checkout must be committed before installation.
3. Downloads Node.js <code>v24.18.0</code> and verifies the official SHA-256 manifest entry.
4. Downloads only WinSW <code>v2.12.0</code> from its fixed release URL and verifies SHA-256 <code>05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da</code>.
5. Builds and tests the source, then removes development dependencies before deployment.
6. Creates or preserves the bearer-token configuration under <code>%ProgramData%\CommandBridgeMCP</code>.
7. Registers the <code>CommandBridgeMCP</code> source in the Application Event Log with <code>New-EventLog</code>.
8. Installs and starts the WinSW service, checks <code>/health</code> and authenticated <code>/ready</code>, executes hostname through MCP, and queries its matching Audit lifecycle under the actual service account.
9. Restores the prior application directory and service if an upgrade fails after the activation step.

The Event Log source registration requires administrator rights. See Microsoft’s [New-EventLog reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/new-eventlog?view=powershell-5.1).

> [!CAUTION]
> <code>-PrintCodexSetup</code> writes the bearer token to the terminal. Use it only in a trusted session and do not paste that block into public issues, shell history, or source control.

## Long command timeouts

From 4.1.15, new configurations allow command requests up to 300 seconds, while omitted `timeoutMs` still uses 15 seconds. Codex setup prints `tool_timeout_sec = 360.0` so termination, Audit and response delivery have extra time. For a long command, request `timeoutMs: 300000`; values above the server maximum are clamped. Existing configured limits are preserved on reinstall: edit `COMMAND_BRIDGE_MAX_TIMEOUT_MS=300000` in the service configuration from an administrator terminal and restart the service. On the Codex client, update only this connection's existing `[mcp_servers.<name>]` section in `~/.codex/config.toml` to `tool_timeout_sec = 360`, preserving URL/token settings, then restart Codex. A client timeout alone does not establish whether the remote operation completed; inspect Audit before repeating an operation.

## Installed layout

~~~text
%ProgramFiles%\CommandBridgeMCP\
├── CommandBridgeMCP.exe             WinSW v2.12.0
├── CommandBridgeMCP.xml             service definition
├── runtime\                         bundled Node.js v24.18.0
└── releases\v<version>-<sha>\        production application and install-info.json

%ProgramData%\CommandBridgeMCP\
├── command-bridge.env               bearer-token configuration
├── policy.json                      administrator-controlled exact argv policies
├── work\                            LocalService writable working root
└── logs\                            WinSW service logs
~~~

The installer removes inherited ACLs and grants the application directory read/execute access to LocalService. Configuration is readable by LocalService; only LocalService can modify the dedicated work and service-log directories. Administrators and SYSTEM retain administrative recovery access.

## Service operations

Version 1.0.3 preserves standard Windows system/program/profile directory variables in the filtered execution environment. Safe built-in cmdlets load only Windows PowerShell's own module manifests, independent of a parent PowerShell 7 or user module search path. Unrelated environment variables are still excluded unless explicitly configured for passthrough. Production timeout settings are unchanged.

If Windows CI fails, a bounded startup probe records whether the PowerShell engine started and whether the fixed wrapper completed. It compares the filtered environment with a parent-environment reference without printing environment values, tokens or command payloads. Local success does not establish that the hosted-runner timeout is resolved; see [validation status](validation-status.md).

The 1.0.1 disposable-runner tests require evidence from the deployed test SHA before accepting an upgrade failure. They verify a changed loopback listener, restored configuration and source identity, preserved work data, and real MCP/Audit access after rollback. These checks do not replace actual reboot testing; see [validation status](validation-status.md) for executed results.

Run these commands from an elevated PowerShell session:

~~~powershell
Get-Service CommandBridgeMCP
Restart-Service CommandBridgeMCP
Stop-Service CommandBridgeMCP
Start-Service CommandBridgeMCP
# Replace HOST and PORT with the values in command-bridge.env:
Invoke-WebRequest -UseBasicParsing http://HOST:PORT/health
~~~

Automatic IP setup binds the selected private interface. Use HTTP only on a trusted LAN or VPN. Firewall rules are not opened automatically; the client must be able to reach this address and port. Reserve the IP in DHCP, or update the listener, allowed Hosts, and client URL if it changes. The built-in listener has no TLS and must not be exposed directly to the public internet. Explicit HTTPS URLs retain the loopback default on fresh installs for a same-host proxy/tunnel.

## Audit log

Every command attempt writes compact JSON without command output. The record includes:

- <code>auditId</code>, timestamp, phase, source, execution mode, shell, and working directory
- a full command after secret redaction
- exit code, signal, duration, timeout/truncation state, and error code

It never includes <code>stdout</code>, <code>stderr</code>, bearer tokens, environment values, or the unredacted command.

Open **Event Viewer → Windows Logs → Application** and filter by source <code>CommandBridgeMCP</code>, or use:

~~~powershell
Get-WinEvent -FilterHashtable @{
  LogName = "Application"
  ProviderName = "CommandBridgeMCP"
} -MaxEvents 50 | Select-Object TimeCreated, Id, LevelDisplayName, Message
~~~

The MCP-side equivalent is the read-only <code>command_bridge_list_audit_events</code> tool:

~~~json
{ "limit": 50 }
~~~

The reader is fixed to the <code>CommandBridgeMCP</code> Application provider and returns at most 100 events per call. It does not accept Event Log query text, an Event Log name, or a provider name from the MCP client. See Microsoft’s [Get-WinEvent reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-winevent?view=powershell-7.5).

Windows Application Event Log retention is controlled by the host’s Event Log policy. The installer does not modify global retention settings. These events are operational audit evidence, not a signed or tamper-evident receipt chain.

## Uninstall

Preview the exact removal without changing the host:

~~~powershell
.\scripts\windows\uninstall.ps1 -DryRun
~~~

Remove the service, installed application, and dedicated Event Log source while preserving configuration and work data:

~~~powershell
.\scripts\windows\uninstall.ps1 -Yes
~~~

Permanently delete the bearer token, configuration, working directory, and WinSW logs:

~~~powershell
.\scripts\windows\uninstall.ps1 -Purge -Yes
~~~

The uninstaller verifies that any existing <code>CommandBridgeMCP</code> service points under the expected Program Files installation path before it removes it.

## Security boundary

The Windows service is not an administrator shell. Keep <code>allowlist</code> mode for normal operation, allow only required working roots, and keep HTTP behind private networking or authenticated TLS. The Application Event Log source can be unregistered by an administrator during uninstall; event retention and administrator-level tampering are outside CommandBridge’s control.

WinSW configuration uses its standard XML service-account support. See the [WinSW XML configuration reference](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md).

## 1.0 migration and reliability

See [the migration guide](migration-1.0.md) for custom native policies, audit backends, authenticated readiness, installation identity, and -RefreshNetwork. The installer validates policies before stopping the existing service and verifies a real MCP command plus its audit ID under LocalService before deleting the backup. The installed uninstaller is %ProgramFiles%\CommandBridgeMCP\uninstall.ps1.

## Optional file transfer (3.1.0)

Upload/download are disabled by default and independent of unrestricted mode. See [secure file transfer](file-transfer.md) for opt-in installer flags, private directories, 5 MiB limits, no-overwrite behavior and Audit/failure handling. Omitted transfer flags preserve existing transfer settings; edit the saved environment settings to disable.

## Command preflight self-protection (4.0.0)

Recognizable direct self-maintenance commands are rejected before execution in all modes. Existing sudo remains available; no broker, privilege ceiling or read-only OS isolation is added. Use a separate administrator terminal for CommandBridge configuration/program/service changes. This is accidental-command prevention, not protection from arbitrary root code. See [the guard and migration guide](self-protection.md) for supported patterns, path checks, false positives and bypass limits.

## Optional guarded mode (4.1.0)

Use `-ExecutionMode guarded` to permit general commands while rejecting recognizable deletion and system changes. Existing sudo/OS permissions remain unchanged; arbitrary scripts/programs can bypass this accident guard. The README installation commands select guarded from 4.1.2. See [rules, mode selection and limitations](guarded-mode.md).

### Audit stalls and execution slots

From 4.1.16, a confirmed finished command releases its execution slot before terminal Audit completes; output is still withheld until Audit succeeds. All runtime Audit reads/writes share a serialized guard with a five-second total wait (including queue time) and at most 64 outstanding operations. A deadline, backend failure or capacity failure makes Audit unavailable until service restart; new commands/transfers fail promptly and `/ready` is not ready. `/health` remains a liveness check. Readiness waits at most five seconds and coalesces an unfinished probe. A timed-out filesystem operation may still complete: it remains tracked, expired queued operations are not started, and shutdown waits for actual I/O within its existing 15-second budget. Resolve host storage problems before restarting and inspect the matching Audit lifecycle before retrying; absence of a reply does not prove the command did not run. Do not increase command parallelism to work around a stalled sink. No Docker daemon/container restart or additional process killing is performed.

## Check the installed version

After upgrading to 4.2.0 or later, Linux provides `command-bridge --version` (or `-V`) without sudo. It uses the bundled runtime and currently selected release; it does not verify service health or fetch the latest GitHub version. If `/usr/local/bin` is not on PATH, use `/usr/local/bin/command-bridge --version`.

Windows PowerShell: `& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" --version`. Windows does not change PATH. npm installations retain `command-bridge-mcp-server --version` and add `command-bridge --version`. From 4.3.0 service-installed launchers also accept update/check commands; the npm/server entry still starts MCP with no arguments. Version queries do not load service configuration, Token, Audit or listeners. Earlier installations need an upgrade before these commands exist.

## Update the installed service (4.3.0+)

Linux: `command-bridge update --check`, then `sudo command-bridge update`. Windows: `& "$env:ProgramFiles\CommandBridgeMCP\command-bridge.cmd" update --check`, then use `update` in an elevated PowerShell terminal. No automatic elevation or unattended background updates are added. A Linux installer-account service must be updated through sudo by its original login account; another account/direct root is rejected. Dedicated-account installations retain their identity. npm installations use npm for updates.

The locally saved bootstrap reads the verified CI channel once and compares full SHA. Identical SHA skips building/restarting; a different SHA at the same version can be updated. Missing/invalid metadata or channel and failed downloads stop before activation. All downloads use the selected SHA. A deployment lock serializes changes (Linux flock; Windows installation/removal mutex). Inside that lock the installer requires the previously observed installed SHA to match; otherwise retry.

Update preserves the complete configuration, execution mode, Token, listener/Host, policy and work data. Account/mode/network changes are not accepted. Existing build/tests, configuration checks, SELinux/ACL handling and real readiness/MCP/Audit verification remain mandatory. The service briefly restarts; failed activation uses existing rollback. Backups are removed only after verification. Update/bootstrap temporary files are cleaned on success or failure; forced termination/power loss can still require inspection. This does not prove an actual machine reboot was tested.

Token output is opt-in: use `update --print-codex-setup`, not with `--check`. Run updates from a separate administrator terminal. Recognizable direct MCP self-updates are blocked; checks are allowed by self-protection, but other execution policies still apply. Indirect scripts remain outside the guard's guarantees. Older installations need one installation upgrade before commands/saved assets exist. Fixed public bootstrap URLs remain unchanged.

From 4.3.1, dependency pruning uses `--no-save` to preserve the source manifests; repeated source installation still requires a clean checkout. Hosted Linux service fixtures explicitly secure their disposable CLI parent instead of weakening production directory validation. Windows lock fixtures use unique mutex names so installation builds do not contend with their own production lock.

From 4.3.2, disposable health-failure fixtures preserve CLI version queries and inject only into server startup for the deployed SHA. Source build/version checks cannot create startup evidence; rollback gates still require the real new-service marker and restored MCP/Audit verification.

From 4.3.3, service restart retries reuse matching startup evidence without replacing the designated failure with a file-exists error. Unexpected evidence remains an error, and each test case still requires its marker to be absent before deployment.

## MCP-managed updates (4.4.0)

Managed service installation provisions the default-enabled fixed-purpose update worker. See [MCP update operations](mcp-update.md) for permissions, status, disabling requests and retained records. This adds narrowly scoped updater authorization, not general sudo rights. Existing command policies and installation mode selection remain unchanged.
