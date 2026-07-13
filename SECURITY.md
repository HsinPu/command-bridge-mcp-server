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
- Do not add the service account to <code>sudo</code>, <code>docker</code>, <code>adm</code>, or <code>systemd-journal</code> groups. Add narrowly scoped privileged helpers later if a specific administrative action is required.
