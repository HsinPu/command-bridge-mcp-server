# Windows service installation

The Windows installer deploys CommandBridge as a WinSW-managed Windows service named <code>CommandBridgeMCP</code>. The service runs as the low-privilege <code>NT AUTHORITY\LocalService</code> account, not as LocalSystem.

## Supported hosts

- Windows 10 or Windows 11 x64
- Windows Server x64
- Elevated Windows PowerShell
- Outbound HTTPS access to GitHub, Node.js, and the npm registry during installation

ARM64 is intentionally deferred until a stable compatible service wrapper is selected.

## Install v0.3.0

Clone or download the release, open an elevated PowerShell session, and run:

~~~powershell
Set-Location C:\path\to\command-bridge-mcp-server
.\scripts\windows\install.ps1 -PrintCodexSetup -CodexUrl "https://command-bridge.example.com/mcp"
~~~

The installer:

1. Requires an administrator session and x64 Windows.
2. Uses the checked-out source when present, otherwise downloads the <code>v0.3.0</code> source archive.
3. Downloads Node.js <code>v24.18.0</code> and verifies the official SHA-256 manifest entry.
4. Downloads only WinSW <code>v2.12.0</code> from its fixed release URL and verifies SHA-256 <code>05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da</code>.
5. Builds and tests the source, then removes development dependencies before deployment.
6. Creates or preserves the bearer-token configuration under <code>%ProgramData%\CommandBridgeMCP</code>.
7. Registers the <code>CommandBridgeMCP</code> source in the Application Event Log with <code>New-EventLog</code>.
8. Installs and starts the WinSW service, checks <code>/health</code>, writes an audit verification event, and confirms the fixed Event Log reader returns only CommandBridge audit events.
9. Restores the prior application directory and service if an upgrade fails after the activation step.

The Event Log source registration requires administrator rights. See Microsoft’s [New-EventLog reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/new-eventlog?view=powershell-5.1).

> [!CAUTION]
> <code>-PrintCodexSetup</code> writes the bearer token to the terminal. Use it only in a trusted session and do not paste that block into public issues, shell history, or source control.

## Installed layout

~~~text
%ProgramFiles%\CommandBridgeMCP\
├── CommandBridgeMCP.exe             WinSW v2.12.0
├── CommandBridgeMCP.xml             service definition
├── runtime\                         bundled Node.js v24.18.0
└── app\                             production CommandBridge application

%ProgramData%\CommandBridgeMCP\
├── command-bridge.env               bearer-token configuration
├── work\                            LocalService writable working root
└── logs\                            WinSW service logs
~~~

The installer removes inherited ACLs and grants the application directory read/execute access to LocalService. Configuration is readable by LocalService; only LocalService can modify the dedicated work and service-log directories. Administrators and SYSTEM retain administrative recovery access.

## Service operations

Run these commands from an elevated PowerShell session:

~~~powershell
Get-Service CommandBridgeMCP
Restart-Service CommandBridgeMCP
Stop-Service CommandBridgeMCP
Start-Service CommandBridgeMCP
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8800/health
~~~

Keep the default loopback HTTP bind unless a private network path and host firewall rule are deliberately configured. The built-in listener has no TLS and must not be exposed directly to the public internet.

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
