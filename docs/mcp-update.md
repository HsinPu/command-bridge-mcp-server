# MCP service updates (introduced in 4.4.0)

Managed Linux and Windows service installations enable `COMMAND_BRIDGE_MCP_UPDATE_ENABLED=true` by default. Existing deployments must first run their existing CLI update or fixed bootstrap installation once. npm/stdio installations do not create the privileged worker; use your package manager there.

## Request and reconnect

Call `command_bridge_update` with `{}`. No source URL, version, command, shell or installer arguments are accepted. Save the returned `jobId`. `accepted` acknowledges a job, not a successful upgrade. The worker waits briefly, then updates independently; MCP sessions may disconnect when the service restarts. Reconnect and call `command_bridge_get_update_status` with `{"jobId":"<UUID>"}`. With `{}`, it returns the latest job, useful if the acknowledgement was lost. Do not repeatedly retry an uncertain acknowledgement.

States are `accepted`, `running`, `succeeded`, `failed` and `interrupted`. Records include timestamps and before/after package versions and full source SHAs, without installer output, secrets or internal paths. An inactive worker with a pending record is reported as interrupted. A failed job does not by itself prove rollback succeeded; check its installed identity and service readiness. The existing installer verifies readiness, real MCP execution and Audit, and restores the prior deployment when activation fails.

Concurrent requests share the active job. Once accepted, client cancellation/disconnection does not stop the OS worker. A worker has a 45-minute OS limit; a timed-out or interrupted task requires administrator inspection. Existing deployment locks prevent concurrent CLI/installer changes. No background schedule or automatic polling is created.

## Permissions and source

Anyone authorized to use this MCP connection can request this fixed administrative operation, including in allowlist mode. Protect the Bearer Token: an update can interrupt service availability. HTTPS and firewall behavior are unchanged.

The worker obtains the verified `install-channel/channel.txt`, pins the entire download to one full SHA, and uses the existing updater without relaxing checks. It cannot accept custom programs, installer flags or alternate download sources. Same-SHA updates are no-ops. CI publication and dependencies remain trust boundaries; this is not a sandbox against an administrator or an unrestricted account with general root privileges.

Linux provisions root-owned `/usr/local/libexec/command-bridge-update` assets and `command-bridge-update.service` (root oneshot, no boot trigger). `/etc/sudoers.d/command-bridge-update` authorizes only the managed service's numeric UID to run the fixed no-argument request helper. It does not grant general sudo. State is root-owned `/var/lib/command-bridge-update`, readable by the managed policy group; only the fixed root helper writes it.

Windows provisions protected `%ProgramFiles%\CommandBridgeUpdate` assets and the manual SYSTEM scheduled task `CommandBridgeUpdate`. Task permissions give LocalService read/execute, not task modification; program/state ACLs allow only SYSTEM/Administrators to write. State is `%ProgramData%\CommandBridgeUpdate`. Worker assets reside outside the application directory so deployment replacement does not remove the running worker.

Recognizable direct commands modifying/triggering these updater assets are rejected by the existing self-protection checks. Indirect scripts and external root actors remain outside that protection.

## Disable, records and removal

An administrator can add `COMMAND_BRIDGE_MCP_UPDATE_ENABLED=false` to the saved service environment file. The privileged backend checks this before acceptance/execution even if MCP still holds its prior startup configuration. Restart the service to refresh reported settings. Status remains queryable when requests are disabled. Missing setting means enabled; duplicate/invalid values fail closed. This does not disable administrator-run CLI updates.

Every MCP request writes attempted and one terminal acceptance event. A completed acceptance event includes the job ID; it is separate from successful installation. Initial Audit failure prevents dispatch. An acceptance Audit failure may occur after dispatch: query latest status before retrying. The protected worker keeps lifecycle JSONL records (10 MiB rotation, five files) and up to 20 recent job records. They are operational logs, not tamper-proof records. No captured command output or installer logs are returned through the tools. Administrators can inspect capped 1 MiB worker logs in the private diagnostics subdirectory; the ordinary service identity has no direct access to these logs; an existing unrestricted account with general root sudo remains outside this boundary.

Normal uninstall refuses an active worker, removes its OS task/unit, program assets and scoped authorization, and preserves update records. Purge also removes those records. Neither operation removes the installer login account. An interrupted installation or power loss requires normal administrator recovery; service restart/autostart checks do not prove a real machine reboot.
