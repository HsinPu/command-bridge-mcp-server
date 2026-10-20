# Security Policy

CommandBridge MCP executes operating-system commands. Treat every deployment as privileged infrastructure, even when allowlist mode is enabled.

## Supported versions

Only the latest released version receives security fixes. The installation channel selects a main commit only after the required CI checks pass; it does not imply a separately published GitHub Release.

## Reporting a vulnerability

Report vulnerabilities through a private GitHub Security Advisory. Do not include tokens, command output, hostnames, or other sensitive deployment details in a public issue.

## Deployment baseline

- Prefer a dedicated, non-administrator account. The README Linux installer deliberately selects installer-account mode, which retains that login account's existing permissions; it does not add general sudo rights.
- Choose `allowlist` for exact approved commands. The README installers select `guarded`, an accident guard for recognizable operations, not a sandbox for arbitrary scripts or programs.
- Use a private network or an authenticated TLS reverse proxy for HTTP mode.
- Use a unique bearer token per host and rotate it if exposure is suspected.
- Restrict working-directory roots and inherited environment variables.
- In allowlist mode, approve fixed native executables and exact argument combinations in an administrator-managed policy. Keep the policy, binaries and their parent directories unwritable by the service. This is not a sandbox for unsafe administrator-approved programs.
- `unrestricted` deliberately permits shell interpretation and must never be a fallback for invalid policies.
- Never pass passwords, API keys, or private keys as command arguments.
- Treat <code>COMMAND_BRIDGE_ALLOWED_ROOTS</code> as a working-directory restriction, not a filesystem sandbox; command arguments can still name other paths that the service account can read.
- Do not broaden a dedicated service account's privileges with <code>sudo</code>, <code>docker</code>, <code>adm</code>, or <code>systemd-journal</code> membership. Installer-account mode deliberately retains the account's existing access. Linux provisions narrowly scoped, root-managed Audit/diagnostic readers and an update request helper where required; keep their exact account/UID and fixed-command rules and do not replace them with generic sudo access.
- Linux managed helpers require controlled privilege transitions, so the service unit deliberately does not use <code>NoNewPrivileges=true</code> or <code>RestrictSUIDSGID=true</code>. Keep these exceptions scoped to fixed managed helpers; they do not justify adding general sudo permission.
