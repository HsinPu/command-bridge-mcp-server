# Linux systemd installation

The Linux installer is intended for a regular glibc-based server where systemd is PID 1. It installs a private runtime and does not modify the system Node.js installation.

## Supported hosts

- x86_64 or arm64 Linux
- Linux kernel 4.18 or newer, glibc 2.28 or newer, and libstdc++ 6.0.25 or newer, matching the [official Node.js 24 platform baseline](https://github.com/nodejs/node/blob/main/BUILDING.md#platform-list)
- Alpine and other musl systems are not supported
- systemd running as PID 1
- At least 400 MB free under `/opt`
- Outbound HTTPS access to `nodejs.org`, `github.com`, and the npm registry
- Standard administration tools including `curl`, `tar`, `gzip`, `sha256sum`, `flock`, `useradd`, `userdel`, `groupdel`, `pgrep`, and `runuser`
- <code>sudo</code>, <code>visudo</code>, <code>journalctl</code>, <code>stat</code>, and <code>rmdir</code> at their normal system paths; the fixed audit reader uses <code>/usr/bin/sudo</code> and <code>/usr/bin/journalctl</code>

Synology DSM is not a systemd host. Use Container Manager or a DSM-specific package there instead.

## Install v0.3.0

One command:

```bash
installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/install.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup && rm -f "${installer}"
```

This command asks for the private HTTPS MCP URL ending in `/mcp`. After a successful installation, it prints a marked block containing the URL, generated or preserved bearer token, and exact instructions to paste into a trusted Codex task. Press Enter at the URL prompt to use a placeholder when the private route is not ready.

To skip the prompt:

```bash
installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/install.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup --codex-url "https://command-bridge.example.com/mcp" && rm -f "${installer}"
```

> [!CAUTION]
> `--print-codex-setup` deliberately prints the bearer token. Paste the block only into a trusted Codex task and delete temporary copies after configuration.

For a review-first installation:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/install.sh -o command-bridge-install.sh
less command-bridge-install.sh
sudo bash command-bridge-install.sh --print-codex-setup
```

The installer performs these steps:

1. Rejects non-Linux, non-systemd, musl, and unsupported CPU environments.
2. Takes an installation lock so two upgrades cannot run at the same time.
3. Downloads pinned Node.js 24.18.0 and verifies its official SHA-256 checksum.
4. Downloads the pinned CommandBridge MCP v0.3.0 source.
5. Creates a unique temporary build account, runs `npm ci --ignore-scripts`, TypeScript compilation, and tests with a clean environment, then freezes ownership and removes that account.
6. Installs immutable runtime and application release directories under `/opt`.
7. Creates the low-privilege <code>command-bridge</code> service account and root-only environment file.
8. Verifies the pinned root-owned audit reader, installs it at <code>/usr/local/libexec/command-bridge-mcp-server/audit-reader</code>, validates the exact no-argument sudoers rule with <code>visudo</code>, and confirms the service account can read only this service's Audit JSON messages.
9. Enables and starts <code>command-bridge-mcp-server.service</code>.
10. Checks <code>/health</code>; an upgrade switches back to the previous release and prior audit-reader assets if the check fails.
11. When explicitly requested, prints the copy-ready Codex configuration block.

## Installed layout

```text
/opt/command-bridge-mcp-server/
├── current -> releases/v0.3.0
├── releases/v0.3.0/
└── runtime/
    ├── current -> node-v24.18.0-linux-{x64|arm64}
    └── node-v24.18.0-linux-{x64|arm64}/

/etc/command-bridge-mcp-server/
└── command-bridge.env                 root:root 0600

/var/lib/command-bridge-mcp-server/
└── work/                              command-bridge:command-bridge 0750

/etc/systemd/system/
└── command-bridge-mcp-server.service
```

The application and Node.js runtime are owned by root. The service account can write only to its state directory and private temporary directory under the default systemd policy.

The installer also creates these root-owned audit access assets:

- <code>/usr/local/libexec/command-bridge-mcp-server/audit-reader</code> (<code>root:root 0755</code>), a no-argument helper that runs only <code>/usr/bin/journalctl --unit command-bridge-mcp-server.service --output=cat --grep='^{"schemaVersion":1,"event":"command_bridge.audit",' --lines=1000</code>, so it emits only CommandBridge Audit JSON rather than arbitrary service logs
- <code>/etc/sudoers.d/command-bridge-mcp-server-audit-reader</code> (<code>root:root 0440</code>), which permits <code>command-bridge ALL=(root) NOPASSWD: /usr/local/libexec/command-bridge-mcp-server/audit-reader ""</code> and nothing else

The service account is not added to <code>sudo</code> or <code>systemd-journal</code> groups.

## Default configuration

The installer generates `/etc/command-bridge-mcp-server/command-bridge.env` only when it does not already exist, and it never replaces an existing bearer token. It prints the token only when `--print-codex-setup` or `--codex-url` is explicitly supplied.

```dotenv
COMMAND_BRIDGE_TRANSPORT=http
COMMAND_BRIDGE_BEARER_TOKEN=<generated-64-character-token>
COMMAND_BRIDGE_HTTP_HOST=127.0.0.1
COMMAND_BRIDGE_HTTP_PORT=8800
COMMAND_BRIDGE_ALLOWED_HOSTS=
COMMAND_BRIDGE_EXECUTION_MODE=allowlist
COMMAND_BRIDGE_ALLOWED_SHELLS=bash
COMMAND_BRIDGE_ALLOWED_COMMANDS=uname,hostname,whoami,uptime,date,df,free,ps,pwd
COMMAND_BRIDGE_ALLOWED_ROOTS=/var/lib/command-bridge-mcp-server/work
COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS=15000
COMMAND_BRIDGE_MAX_TIMEOUT_MS=60000
COMMAND_BRIDGE_MAX_OUTPUT_CHARS=50000
COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS=2
COMMAND_BRIDGE_PASSTHROUGH_ENV=
```

Read the token locally as root:

```bash
sudo awk -F= '$1 == "COMMAND_BRIDGE_BEARER_TOKEN" { print substr($0, index($0, "=") + 1) }' /etc/command-bridge-mcp-server/command-bridge.env
```

## Copy-ready Codex setup

The output between `BEGIN COPY FOR CODEX` and `END COPY FOR CODEX` is a prompt, not a shell script. Copy the entire block into a trusted Codex task on the client machine. It tells Codex to:

1. Persist `COMMAND_BRIDGE_BEARER_TOKEN` as a user environment variable appropriate for the client operating system.
2. Add or update `[mcp_servers.command_bridge]` in the user-level `~/.codex/config.toml`.
3. Reference the token through `bearer_token_env_var` instead of placing the secret in TOML.
4. Preserve unrelated settings, report restart requirements, and verify the MCP connection after restart.

`--codex-url` accepts only an HTTPS URL ending in `/mcp`, without embedded credentials, a query, or a fragment. The built-in CommandBridge listener remains plain HTTP on loopback; the HTTPS URL must therefore come from a private route such as Tailscale Serve, Cloudflare Tunnel, or an authenticated TLS reverse proxy.

After editing the environment file, restart the service:

```bash
sudo systemctl restart command-bridge-mcp-server
```

## Service operations

```bash
sudo systemctl status command-bridge-mcp-server
sudo systemctl restart command-bridge-mcp-server
sudo systemctl stop command-bridge-mcp-server
sudo systemctl start command-bridge-mcp-server
sudo systemctl is-enabled command-bridge-mcp-server
sudo journalctl -u command-bridge-mcp-server -n 100 --no-pager
sudo journalctl -u command-bridge-mcp-server -f
curl -fsS http://127.0.0.1:8800/health
```

## Audit log

For every <code>command_bridge_run_command</code> request, CommandBridge writes compact JSON to standard error before process start and after the terminal outcome. The systemd unit routes standard error to the service journal.

Host administrators can inspect the records with:

~~~bash
sudo journalctl --unit command-bridge-mcp-server.service --output=json --no-pager --lines 1000
sudo journalctl --unit command-bridge-mcp-server.service --no-pager --lines 100
~~~

Codex can call the read-only <code>command_bridge_list_audit_events</code> MCP tool with a <code>limit</code> from 1 through 100. The server invokes only the installed fixed reader through non-interactive sudo; it cannot pass journal units, query strings, paths, or other arguments from the MCP client.

Each accepted event is redacted again before it is returned. Events contain audit ID, timestamp, phase, redacted command, shell, working directory, mode, source, exit code, duration, timeout/truncation, and error code. They never contain command output, bearer tokens, environment values, or raw secrets. The redactor cannot be disabled.

Journald retention is a host policy. This installer does not change global journal retention. The log is operational evidence, not a signed, immutable, or tamper-evident audit ledger.

## Uninstall

The default one-command uninstall stops and disables the service, removes <code>/etc/systemd/system/command-bridge-mcp-server.service</code>, removes the audit reader and its restricted sudoers file, reloads systemd, and deletes <code>/opt/command-bridge-mcp-server</code>:

```bash
uninstaller="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --yes && rm -f "${uninstaller}"
```

It preserves these resources for a future reinstall:

- `/etc/command-bridge-mcp-server`, including the bearer token
- `/var/lib/command-bridge-mcp-server`, including all work data
- The `command-bridge` account, group, and `/var/empty/command-bridge` home

For review and a no-change preview:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o command-bridge-uninstall.sh
less command-bridge-uninstall.sh
sudo bash command-bridge-uninstall.sh --dry-run
sudo bash command-bridge-uninstall.sh --yes
```

For a permanent full purge:

> [!CAUTION]
> This deletes the bearer token, configuration, all work data, and the dedicated service identity. The uninstaller refuses to delete an identity whose home, shell, group membership, or running processes do not match the expected low-privilege service account.

```bash
uninstaller="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.3.0/scripts/linux-systemd/uninstall.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --purge --yes && rm -f "${uninstaller}"
```

Both modes use the same lock as the installer, accept only the fixed CommandBridge paths, verify that the service is inactive and disabled before deleting application files, and can be run repeatedly.

## Remote access

The default endpoint listens only on loopback. Keep that setting when a same-host TLS reverse proxy, Cloudflare Tunnel, or Tailscale Serve forwards requests to CommandBridge.

For a direct private-interface bind, edit the root-owned environment file and set both an exact interface address and allowed Host values:

```dotenv
COMMAND_BRIDGE_HTTP_HOST=100.64.10.20
COMMAND_BRIDGE_ALLOWED_HOSTS=100.64.10.20,command-bridge.internal
```

Then restrict port 8800 with the host firewall and restart the service. `COMMAND_BRIDGE_ALLOWED_HOSTS` protects Host header handling; it is not a source-IP firewall. CommandBridge HTTP does not provide TLS, so do not expose it directly to the public internet or send its bearer token over an untrusted network.

## Permission boundary

The default service is a low-privilege diagnostic agent, not a root shell. Its account has no login shell, Docker access, or supplementary groups. It has one fixed no-argument sudoers permission solely for the root-owned audit reader; it has no generic sudo command access. Commands such as <code>systemctl restart</code>, package installation, firewall changes, and arbitrary file modification are intentionally unavailable.

The controlled reader requires a sudo privilege transition, so the systemd unit cannot use <code>NoNewPrivileges=true</code> or <code>RestrictSUIDSGID=true</code>. Do not change that exception into broad sudo access or add the service account to privileged groups.

`COMMAND_BRIDGE_ALLOWED_ROOTS` restricts the command working directory. It does not stop an allowed command from naming another readable path as an argument. The real boundary is the service account plus the systemd filesystem and capability restrictions.

If a future workflow needs one privileged operation, add a purpose-built helper or narrowly scoped Polkit rule. Do not run the general MCP server as root and do not add its account to the Docker group.

## Reinstall and upgrade behavior

Running the v0.3.0 installer again is idempotent: it reuses the pinned runtime and release, preserves configuration, reloads the unit, and rechecks service health.

Future versions will use their own versioned release directory. The installer records the current application and runtime symlinks before activation. If the new process cannot become active and pass `/health`, the symlinks are restored and the previous service is restarted.

The source build is pinned to a Git tag and npm lockfile. The Node.js archive is checksum-verified. A future release artifact workflow will add a separately checksummed, prebuilt offline bundle so hosts do not need to compile source during installation.
