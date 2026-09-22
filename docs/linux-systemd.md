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

## Install the latest verified source

The fixed bootstrap selects the latest main commit that passed CI through install-channel/channel.txt. No tag, Git, or preinstalled Node.js is required. A missing channel stops installation without falling back to unverified source.

One command:

```bash
installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup && rm -f "${installer}"
```

No URL prompt is required. A fresh installation selects a private IPv4 address, preferring the default-route interface, and configures both the listener and allowed Host. It prints `http://<IP>:<port>/mcp` and the generated or preserved bearer token in a marked Codex setup block. Detection accepts RFC1918 and 100.64.0.0/10 addresses (including Tailscale); without one it falls back to `127.0.0.1`, usable only on this host. Existing configuration is preserved, and the printed URL uses its saved host and port. A wildcard IPv4 bind uses the detected private IP; a wildcard IPv6 bind prints IPv6 loopback for local setup.

To use an existing private HTTPS route instead:

```bash
installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup --codex-url "https://command-bridge.example.com/mcp" && rm -f "${installer}"
```

> [!CAUTION]
> `--print-codex-setup` deliberately prints the bearer token. Paste the block only into a trusted Codex task and delete temporary copies after configuration.

For a review-first installation:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o command-bridge-install.sh
less command-bridge-install.sh
sudo bash command-bridge-install.sh --print-codex-setup
```

The installer performs these steps:

1. Rejects non-Linux, non-systemd, musl, and unsupported CPU environments.
2. Takes an installation lock so two upgrades cannot run at the same time.
3. Downloads pinned Node.js 24.18.0 and verifies its official SHA-256 checksum.
4. Uses the source archive fixed to the CI-verified commit SHA.
5. Creates a unique temporary build account, runs `npm ci --ignore-scripts`, TypeScript compilation, and tests with a clean environment, then freezes ownership and removes that account.
6. Installs immutable runtime and application release directories under `/opt`.
7. Creates the low-privilege <code>command-bridge</code> service account and root-only environment file.
8. Verifies the pinned root-owned audit reader, installs it at <code>/usr/local/libexec/command-bridge-mcp-server/audit-reader</code>, validates the exact no-argument sudoers rule with <code>visudo</code>, and confirms the service account can read only this service's Audit JSON messages.
9. Enables and starts <code>command-bridge-mcp-server.service</code>.
10. Checks <code>/health</code> and authenticated <code>/ready</code>, executes hostname through a real MCP connection, and reads its matching Audit lifecycle. Failure restores the prior release, network configuration and audit-reader assets.
11. When explicitly requested, prints the copy-ready Codex configuration block.

## Installed layout

The 1.0.1 disposable-runner tests require evidence from the deployed test SHA before accepting an upgrade failure. They verify a changed loopback listener, restored configuration and source identity, preserved work data, and real MCP/Audit access after rollback. These checks do not replace actual reboot testing; see [validation status](validation-status.md) for executed results.

```text
/opt/command-bridge-mcp-server/
├── current -> releases/v1.0.1-<source-sha>
├── releases/v1.0.1-<source-sha>/
└── runtime/
    ├── current -> node-v24.18.0-linux-{x64|arm64}
    └── node-v24.18.0-linux-{x64|arm64}/

/etc/command-bridge-mcp-server/
├── command-bridge.env                 root:root 0600
└── policy.json                        root:command-bridge 0640

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
COMMAND_BRIDGE_AUDIT_BACKEND=journal
COMMAND_BRIDGE_POLICY_FILE=/etc/command-bridge-mcp-server/policy.json
COMMAND_BRIDGE_BEARER_TOKEN=<generated-64-character-token>
COMMAND_BRIDGE_HTTP_HOST=<detected-private-ip-or-127.0.0.1>
COMMAND_BRIDGE_HTTP_PORT=8800
COMMAND_BRIDGE_ALLOWED_HOSTS=<selected-ip-for-non-loopback>
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

`--codex-url` accepts only an HTTPS URL ending in `/mcp`, without embedded credentials, a query, or a fragment. When provided, a fresh install defaults to loopback for use behind a private HTTPS route. An explicit `COMMAND_BRIDGE_HTTP_HOST` overrides detection. For a concrete non-loopback host, allowed Hosts default to that host unless explicitly configured. Wildcard binds still require an explicit allowed Hosts list. Existing configuration is never overwritten. The built-in listener does not provide TLS.

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
# Replace HOST and PORT with the values in command-bridge.env:
curl -fsS http://HOST:PORT/health
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
uninstaller="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --uninstall --yes && rm -f "${uninstaller}"
```

It preserves these resources for a future reinstall:

- `/etc/command-bridge-mcp-server`, including the bearer token
- `/var/lib/command-bridge-mcp-server`, including all work data
- The `command-bridge` account, group, and `/var/empty/command-bridge` home

For review and a no-change preview:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o command-bridge-uninstall.sh
less command-bridge-uninstall.sh
sudo bash command-bridge-uninstall.sh --uninstall --dry-run
sudo bash command-bridge-uninstall.sh --uninstall --yes
```

For a permanent full purge:

> [!CAUTION]
> This deletes the bearer token, configuration, all work data, and the dedicated service identity. The uninstaller refuses to delete an identity whose home, shell, group membership, or running processes do not match the expected low-privilege service account.

```bash
uninstaller="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --uninstall --purge --yes && rm -f "${uninstaller}"
```

Both modes use the same lock as the installer, accept only the fixed CommandBridge paths, verify that the service is inactive and disabled before deleting application files, and can be run repeatedly.

## Remote access

Automatic IP setup binds the selected private interface, not every interface. Use its HTTP URL only on a trusted LAN or VPN; the installer does not open the firewall or provision TLS. The client must be able to reach the selected address and port. Reserve the IP in DHCP, or update the listener, allowed Hosts, and client URL if it changes. To use a same-host HTTPS proxy or tunnel, pass `--codex-url` on a fresh install, or explicitly configure loopback for an existing installation.

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

Running the same verified installer again is idempotent: it reuses the pinned runtime and release, preserves configuration, reloads the unit, and rechecks service health.

Future versions will use their own versioned release directory. The installer records the current application and runtime symlinks before activation. If the new process cannot become active and pass `/health`, the symlinks are restored and the previous service is restarted.

The source build is pinned to a full commit SHA and npm lockfile. The Node.js archive is checksum-verified. A future release artifact workflow will add a separately checksummed, prebuilt offline bundle so hosts do not need to compile source during installation.

## 1.0 migration and reliability

See [the migration guide](migration-1.0.md) for custom native policies, audit backends, authenticated readiness, installation identity, and --refresh-network. The installer checks existing policies before switching releases and verifies a real MCP command plus its audit ID before completing activation. The saved uninstaller is current/uninstall.sh; install-info.json records the version, source SHA and runtime.
