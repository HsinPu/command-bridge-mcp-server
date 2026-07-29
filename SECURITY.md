# Security Policy

CommandBridge MCP executes operating-system commands. Treat every deployment as privileged infrastructure, even when allowlist mode is enabled.

## Supported versions

Only the latest released version will receive security fixes while the project is pre-1.0.

## Reporting a vulnerability

After the GitHub repository is published, report vulnerabilities through a private GitHub Security Advisory. Do not include tokens, command output, hostnames, or other sensitive deployment details in a public issue.

## Deployment baseline

- Run the process as a dedicated, non-administrator account.
- Keep `COMMAND_BRIDGE_EXECUTION_MODE=allowlist` unless unrestricted execution is explicitly required.
- Use a private network or an authenticated TLS reverse proxy for HTTP mode.
- Use a unique bearer token per host and rotate it if exposure is suspected.
- Restrict working-directory roots and inherited environment variables.
- Never pass passwords, API keys, or private keys as command arguments.
- Treat <code>COMMAND_BRIDGE_ALLOWED_ROOTS</code> as a working-directory restriction, not a filesystem sandbox; command arguments can still name other paths that the service account can read.
- Do not add the service account to <code>sudo</code>, <code>docker</code>, <code>adm</code>, or <code>systemd-journal</code> groups. On Linux, the installer creates one exact no-argument sudoers rule only for the root-owned audit reader; do not expand, reuse, or replace it with generic sudo access.
- The Linux audit reader needs that controlled sudo transition, so the service unit deliberately does not use <code>NoNewPrivileges=true</code> or <code>RestrictSUIDSGID=true</code>. This exception must remain limited to the fixed reader.
