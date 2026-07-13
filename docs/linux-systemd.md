# Linux systemd installation

The Linux installer is intended for a regular glibc-based server where systemd is PID 1. It installs a private runtime and does not modify the system Node.js installation.

## Supported hosts

- x86_64 or arm64 Linux
- Linux kernel 4.18 or newer, glibc 2.28 or newer, and libstdc++ 6.0.25 or newer, matching the [official Node.js 24 platform baseline](https://github.com/nodejs/node/blob/main/BUILDING.md#platform-list)
- Alpine and other musl systems are not supported
- systemd running as PID 1
- At least 400 MB free under `/opt`
- Outbound HTTPS access to `nodejs.org`, `github.com`, and the npm registry
- Standard administration tools including `curl`, `tar`, `gzip`, `sha256sum`, `flock`, `useradd`, and `runuser`

Synology DSM is not a systemd host. Use Container Manager or a DSM-specific package there instead.

## Install v0.2.0

One command:

```bash
installer="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.2.0/install.sh -o "${installer}" && sudo bash "${installer}" && rm -f "${installer}"
```

For a review-first installation:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/v0.2.0/install.sh -o command-bridge-install.sh
less command-bridge-install.sh
sudo bash command-bridge-install.sh
```

The installer performs these steps:

1. Rejects non-Linux, non-systemd, musl, and unsupported CPU environments.
2. Takes an installation lock so two upgrades cannot run at the same time.
3. Downloads pinned Node.js 24.18.0 and verifies its official SHA-256 checksum.
4. Downloads the pinned CommandBridge MCP v0.2.0 source.
5. Creates a unique temporary build account, runs `npm ci --ignore-scripts`, TypeScript compilation, and tests with a clean environment, then freezes ownership and removes that account.
6. Installs immutable runtime and application release directories under `/opt`.
7. Creates the low-privilege `command-bridge` service account and root-only environment file.
8. Enables and starts `command-bridge-mcp-server.service`.
9. Checks `/health`; an upgrade switches back to the previous release if the check fails.

## Installed layout

```text
/opt/command-bridge-mcp-server/
├── current -> releases/v0.2.0
├── releases/v0.2.0/
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

## Default configuration

The installer generates `/etc/command-bridge-mcp-server/command-bridge.env` only when it does not already exist. It never prints or replaces an existing bearer token.

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

## Remote access

The default endpoint listens only on loopback. Keep that setting when a same-host TLS reverse proxy, Cloudflare Tunnel, or Tailscale Serve forwards requests to CommandBridge.

For a direct private-interface bind, edit the root-owned environment file and set both an exact interface address and allowed Host values:

```dotenv
COMMAND_BRIDGE_HTTP_HOST=100.64.10.20
COMMAND_BRIDGE_ALLOWED_HOSTS=100.64.10.20,command-bridge.internal
```

Then restrict port 8800 with the host firewall and restart the service. `COMMAND_BRIDGE_ALLOWED_HOSTS` protects Host header handling; it is not a source-IP firewall. CommandBridge HTTP does not provide TLS, so do not expose it directly to the public internet or send its bearer token over an untrusted network.

## Permission boundary

The default service is a low-privilege diagnostic agent, not a root shell. Its account has no login shell, sudo access, Docker access, or supplementary groups. Commands such as `systemctl restart`, package installation, firewall changes, and arbitrary file modification are intentionally unavailable.

`COMMAND_BRIDGE_ALLOWED_ROOTS` restricts the command working directory. It does not stop an allowed command from naming another readable path as an argument. The real boundary is the service account plus the systemd filesystem and capability restrictions.

If a future workflow needs one privileged operation, add a purpose-built helper or narrowly scoped Polkit rule. Do not run the general MCP server as root and do not add its account to the Docker group.

## Reinstall and upgrade behavior

Running the v0.2.0 installer again is idempotent: it reuses the pinned runtime and release, preserves configuration, reloads the unit, and rechecks service health.

Future versions will use their own versioned release directory. The installer records the current application and runtime symlinks before activation. If the new process cannot become active and pass `/health`, the symlinks are restored and the previous service is restarted.

The source build is pinned to a Git tag and npm lockfile. The Node.js archive is checksum-verified. A future release artifact workflow will add a separately checksummed, prebuilt offline bundle so hosts do not need to compile source during installation.
