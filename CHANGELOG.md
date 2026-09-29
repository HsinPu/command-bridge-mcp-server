# Changelog

## 2.0.1 — 2026-09-29

Patch release from 2.0.0: document the established Linux service and path naming rules for future changes, with no runtime behavior changes.

- Record the canonical Linux `command-bridge.service` and `/opt`, `/etc`, `/var/lib` locations, the unchanged repository/npm/Windows/MCP names, and the required 1.x migration, rollback and data-preservation checks in AGENTS.md.
- Synchronize package metadata, README version badges and current-version examples in the platform guide; clarify current and historical Linux policy paths in the migration guide. The fixed bootstrap URL and historical 2.0.0 migration record are unchanged.

## 2.0.0 — 2026-09-29

Major release from 1.0.5: the Linux systemd service and canonical application, configuration and state paths change from `command-bridge-mcp-server` to `command-bridge`. Existing scripts that reference the old service name must use `command-bridge`; the GitHub repository, npm package, MCP tools and Windows service are unchanged.

- New Linux installations use `/opt/command-bridge`, `/etc/command-bridge`, `/var/lib/command-bridge` and `command-bridge.service`.
- On upgrade, the installer validates the old configuration before switching services, moves the existing directories without replacing the token or working data, and keeps old directory names as links for existing absolute paths. A failed new-service activation moves the directories back and restores the old release and service.
- The bootstrap still uses the fixed repository URL and the CI-verified full source SHA. This version is not available through the public bootstrap until Windows/Linux CI and service validation publish its SHA to `install-channel`.
- Local Ubuntu WSL service checks passed for a fresh installation and a real 1.0.5 upgrade, including a forced post-activation failure, old-service recovery, MCP/Audit checks and purge. Hosted CI remains the publication gate.

## 1.0.5 — 2026-09-29

Patch release from 1.0.4: repair service deployment validation and recovery without changing MCP interfaces or command policies.

- Clear the failed candidate's systemd start-limit counter before restarting the restored release. Report a restored-service restart failure instead of silently discarding it.
- Report Linux smoke failure line and service state without printing configuration. Add Windows startup categories, listener/child-process presence and bounded log excerpts; redact the configured token and credential fields, and exclude Audit payloads, configuration and environment dumps.
- Suppress PowerShell download progress rendering while retaining checksum verification.
- Probe Windows service health directly without Internet proxy/WPAD, preserve the configured Host header and handle IPv6 listener URLs. Exercise the probe against a real local HTTP server.
- Preserve only standard Windows directory variables for Audit PowerShell helpers and load their trusted built-in modules explicitly; retain the five-second helper limit. Include rotated startup logs and safe Audit failure categories in diagnostics. Wait for restored Windows listeners before mandatory MCP/Audit checks.
- Local Windows validation passed 61/64 tests with three Linux skips; hosted Linux service lifecycle passed after the rollback fix. Full cross-platform service verification controls channel publication; see docs/validation-status.md and the CI run for the channel's source SHA. A version entry alone does not publish an installation snapshot.

## 1.0.4 — 2026-09-29 (unreleased)

Patch release from 1.0.3: fix Linux installation and native Audit startup without changing MCP interfaces or command policies.

- Isolate npm user/global configuration in distinct empty, build-account-owned files so npm accepts clean installation and pruning.
- Correct allowed Host validation for IPv4, hostname lists and bracketed IPv6; cover valid and invalid values with executable Bash tests.
- Allow an empty journal on first installation while propagating journal read failures. The fixed reader filters Audit JSON from the latest 1,000 service entries; unrelated service messages remain excluded.
- Permit only CAP_SETUID and CAP_SETGID in the service capability ceiling for the fixed sudo Audit reader, with no ambient capabilities for the service process. Keep exact no-argument sudo authorization and root-owned assets.
- Remove systemd settings that implicitly prohibit the required sudo transition. Retain filesystem/resource restrictions and use DevicePolicy=closed; document the unavailable syscall restrictions explicitly.
- Return success when optional Codex setup output is disabled, instead of reporting a completed installation as failed. Service smoke tests also check the real process has no effective or ambient capabilities.
- Bound service-test waits for the listener after Type=simple restarts before requiring authenticated readiness, real MCP and Audit verification; keep production timeouts unchanged.
- Validated the complete Linux service lifecycle locally on Ubuntu WSL with Node.js 24.18.0, including activation evidence, changed-network rollback and uninstall/reinstall/purge. Linux suites passed 58/62 (four Windows skips); Windows compatibility passed 59/62 (three Linux skips). Hosted CI and channel publication remain pending.

## 1.0.3 — 2026-09-29 (unreleased)

Patch release from 1.0.2: make Windows PowerShell startup more deterministic and improve CI failure diagnosis, without changing command policies or timeout budgets.

- Preserve standard Windows system/program/profile directory variables in the filtered child environment without inheriting unrelated secrets.
- Pin safe cmdlet module discovery to Windows PowerShell's own Modules directory, load required modules by absolute manifest path, and avoid New-Object during wrapper initialization.
- Test the fixed wrapper against external module paths, unknown cmdlets and injected arguments. Add a bounded, failure-only CI probe that reports engine/wrapper stages without dumping environment values or command payloads.
- The previous CI timeout could not be reproduced on local Windows 10 with Node.js 20.15.1 or 24.18.0. CI resolution remains unconfirmed until the updated workflow runs; the Linux npm configuration blocker is unchanged.

## 1.0.2 — 2026-09-29 (unreleased)

Patch release from 1.0.1: documentation and working-rule maintenance with no runtime behavior changes.

- Require a version bump and CHANGELOG entry for every delivered batch of changes, including AGENTS.md, README, validation records, comments and formatting. Documentation-only changes use PATCH.
- Remove the previous documentation-only version exemption and synchronize current version references. Existing Linux installation and Windows CI blockers are unchanged.

## 1.0.1 — 2026-09-22 (unreleased)

Patch release from 1.0.0: fixes CI timing and rollback test coverage without changing the MCP interface, command policies or production deadlines.

- Give successful PowerShell execution tests a consistent 15-second budget and report detailed results on failure; retain dedicated short-timeout tests and always shut down the executor.
- Inject verification failure only after real MCP/Audit verification in the deployed test SHA. Require activation evidence so earlier build failures cannot pass rollback tests.
- Test a genuinely changed loopback listener and Host, then verify configuration, token, release identity, working data and real MCP/Audit access after rollback on both platforms.
- Require startup evidence for health-failure tests and add injection boundary checks. Channel publication remains gated by all cross-platform checks and service tests.

## 1.0.0 — 2026-09-22 (unreleased)

Major release from the 0.5.0 implementation stage: allowlist mode no longer accepts arbitrary shell argument syntax. The existing MCP tools and result fields remain, but custom allowlists require explicit policies.

- Literal command parsing, exact argv matching, fixed native executables and a fixed PowerShell cmdlet wrapper replace shell interpretation in allowlist mode.
- COMMAND_BRIDGE_POLICY_FILE defines administrator-controlled schemaVersion 1 policies. Missing, duplicate, invalid or unsupported enabled policies fail before activation. Shells/script hosts cannot be custom safe targets.
- Resolve working directories through real paths to reject symlink/junction escapes and validate empty root entries before resolving.
- Includes the CI-verified installation channel and reliability improvements described under 0.5.0. No version tag is required by the new bootstrap.
- Migration: review [the 1.0 guide](docs/migration-1.0.md), create exact custom argument policies, protect policy permissions, and retain hostname for installation verification. Old complex arguments may now be rejected; unrestricted is never selected automatically.
- Validation: cross-platform unit/integration checks plus disposable service lifecycle CI gate channel publication. Local Windows testing does not substitute for an executed Linux/Windows service CI run.

## 0.5.0 — 2026-09-22 (unreleased implementation stage)

Minor release from 0.4.0: CI-verified bootstrap installation and reliability improvements, retaining the existing MCP interface.

- Fixed bootstrap URLs resolve a successful main commit through the serialized install channel. All source and installation assets come from one SHA; no release tag is required.
- Build-time application version comes from package.json. Installed identities include version, source SHA, and runtime version; uninstallers are saved with installations.
- Bounded process termination, cancellation and shutdown; audit helper deadlines; private rotating file audit for local stdio.
- Authenticated readiness and real service-account MCP/audit verification before upgrade backups are removed.
- Explicit network refresh preserves tokens and restores prior configuration on failure.

## 0.4.0 — 2026-09-22 (unreleased)

Minor release from 0.3.1: adds automatic IP-based connection setup while preserving existing installations and explicit HTTPS URLs.

- Fresh installations without an explicit URL or listener override select a private IPv4 address, preferring a default-route interface, and set the listener and allowed Host together. Supported ranges are RFC1918 and 100.64.0.0/10 (including Tailscale); no match falls back to loopback.
- Print the actual configured HTTP listener address and port in the Codex setup block without prompting for a URL. Existing configuration and tokens are preserved; explicit HTTPS URLs keep the loopback default for fresh installations.
- Generated HTTP URLs are for trusted LAN/VPN use. TLS and firewall rules are not provisioned. DHCP address changes require updating listener, allowed hosts, and client URL.
- Simplify both READMEs to one-command installation and uninstall for Windows/Linux; keep advanced details in deployment guides.
- Remote commands require publishing tag v0.4.0 first.

## 0.3.1 — 2026-09-22 (unreleased)

Patch release from 0.3.0: repairs the existing Windows installation flow without changing the MCP interface or adding a new installation mode.

- Document a one-line Windows PowerShell installation that downloads the pinned installer and source from GitHub without requiring Git or a preinstalled Node.js. Stop on download or installer failure and remove the temporary script afterward.
- Replace assignments to PowerShell's read-only Host variable in configuration generation and health checks.
- Add the downloaded Node.js runtime to PATH during build/test/prune and restore PATH afterward, including on failure.
- Count audit verification results as arrays so zero or one matching event works under StrictMode.
- Preserve LF line endings for the fixed Linux audit reader on Windows checkouts so its pinned checksum and the installation test suite remain valid.
- Synchronize package, MCP server, installer source references, and installation documentation to 0.3.1. Remote installation requires publishing tag v0.3.1 first.
