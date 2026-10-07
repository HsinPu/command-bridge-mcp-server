# Linux systemd installation

Version 2.0.0 shortened the Linux service and installation paths to `command-bridge`; the current package is 4.6.0. Version 2.1.0 added an opt-in installer-account service mode; 2.1.2 completed rollback when that candidate fails before Audit-reader changes. Version 2.2.0 adds a host-specific name to the printed Codex client setup. The GitHub repository, npm package, Windows service and MCP tool names are unchanged. The 2.0.3 Oracle Linux SELinux repair remains in place.

The Linux installer is intended for a regular glibc-based server where systemd is PID 1. It installs a private runtime and does not modify the system Node.js installation.

## Supported hosts

- x86_64 or arm64 Linux
- Linux kernel 4.18 or newer, glibc 2.28 or newer, and libstdc++ 6.0.25 or newer, matching the [official Node.js 24 platform baseline](https://github.com/nodejs/node/blob/main/BUILDING.md#platform-list)
- Alpine and other musl systems are not supported
- systemd running as PID 1
- At least 400 MB free on the filesystem containing `/usr/local/lib/command-bridge`, plus space for a full copy of any old program deployment during migration; `/tmp` also needs room for downloads and the isolated build
- Outbound HTTPS access to `nodejs.org`, `github.com`, and the npm registry
- Standard administration tools including `curl`, `tar`, `gzip`, `sha256sum`, `flock`, `useradd`, `userdel`, `groupdel`, `pgrep`, and `runuser`
- <code>sudo</code>, <code>stat</code>, and <code>rmdir</code> at their normal system paths; both account modes also need <code>visudo</code> and <code>/usr/bin/journalctl</code> for the fixed diagnostic reader; dedicated-account mode additionally provisions its Audit reader

Synology DSM is not a systemd host. Use Container Manager or a DSM-specific package there instead.

## Install the latest verified source

The fixed bootstrap selects the latest main commit that passed CI through install-channel/channel.txt. No tag, Git, or preinstalled Node.js is required. A missing channel stops installation without falling back to unverified source.

The README uses installer-account mode with guarded on every installation; it does not enable unrestricted commands. Run its command from your non-root login account; see the next section for its permissions and Audit behavior. To use the installer's default dedicated-account mode with the allowlist instead:

```bash
(installer="$(mktemp)" && trap 'rm -f -- "${installer}"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup)
```

## Return to allowlist mode

To restore allowlist, remove `--guarded` from the README Linux command before running it: every Linux installation writes `allowlist` unless `--guarded` or `--run-as-installer --unrestricted` is explicitly passed. Saved execution mode and inherited `COMMAND_BRIDGE_EXECUTION_MODE` environment values no longer override that selection. This is a breaking upgrade change: add `--unrestricted` on every install if unrestricted execution is required. Tokens, network settings, custom roots and policy files are preserved; validation failures restore the old configuration and service.

For an existing installation before upgrading, you can also change the mode manually:

```bash
sudoedit /etc/command-bridge/command-bridge.env
```

Set the existing entry to `COMMAND_BRIDGE_EXECUTION_MODE=allowlist`, save the file, then restart and check the service:

```bash
sudo systemctl restart command-bridge
sudo systemctl is-active command-bridge
```

With the default policies, `rm` and `sudo -n rm` are rejected, and sudo operations are not automatically permitted. Custom native policies can still allow destructive behavior; the allowlist is not a filesystem sandbox. Review permitted commands and argument combinations before enabling additional management operations. Invalid policy configuration fails closed; inspect startup diagnostics if the service cannot restart.

## Temporary files and failed installations

The copy-ready commands use a subshell EXIT trap to remove the downloaded bootstrap script even when curl or installation fails; they do not replace traps in your interactive shell. Bootstrap source archives, build files and the isolated npm cache are removed on normal exit. Runtime/release `.new.<pid>` directories are tracked before creation and removed on exit only when their parent is a managed deployment directory and their suffix matches this invocation; symlinks and unrelated paths are rejected. Program relocation also tracks and removes its own `.command-bridge-migrate.*` staging directory on failure. Promoted runtimes/releases, previous versions, tokens and work data are retained. Configuration restoration failures are reported without preventing temporary-file cleanup. Cleanup errors are reported; SIGKILL, power loss and filesystem failures can leave temporary files. Uninstall checks managed program roots and migration backups, but never sweeps arbitrary temporary remnants.

## Installer-account mode

If MCP commands must use the same access as the non-root login account that runs the installer through `sudo`, opt in explicitly. For unrestricted shell commands under that account, including only its **existing** passwordless sudo permissions:

```bash
(installer="$(mktemp)" && trap 'rm -f -- "${installer}"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup --run-as-installer --unrestricted)
```

On every install, leave off both `--guarded` and `--unrestricted` to select allowlist; a sudo command then also needs an exact administrator-managed command policy. Reinstallation selects the mode from the current options rather than the saved mode. `--unrestricted` cannot be used without `--run-as-installer`. The original account comes from `SUDO_USER`/`SUDO_UID`; direct root execution and a later reinstall by a different login account are rejected. The installer does **not** change its persistent groups or grant any general privilege. From 4.4.0, a separate exact no-argument sudoers rule permits only the fixed managed-update request helper. A command such as `sudo -n /usr/bin/id -u` can succeed only if the account's existing sudo policy allows it without a password. The background service has no terminal for password entry.

The installer-account unit uses that account's UID and normal group memberships, plus the dedicated `command-bridge` group to read the root-owned policy. It allows home access and normal filesystem permissions. It does not apply the dedicated account's read-only filesystem, private temporary directory or capability ceiling, so existing sudo privileges remain usable. Anyone holding the bearer token can invoke the selected command policy using this account. Keep the endpoint on a trusted LAN/VPN or private HTTPS route and guard the token accordingly.

This mode switches Audit to owner-only JSONL files under `/var/lib/command-bridge-installer/CommandBridgeMCP/audit` (10 MiB per file, five files). It removes the old dedicated-account Audit reader and exact sudoers rule only after the new service passes real MCP/Audit verification. A failed switch restores the prior unit, configuration and helper. Existing bearer token, network settings, policy and `/var/lib/command-bridge/work` data are preserved; when switching from the dedicated account, the working-directory roots become the login account's home followed by `/`. Subsequent reinstalls preserve custom roots. File Audit is writable by the service account and is not an immutable security ledger.

Starting with 2.2.1, installer-account mode does not create the dedicated `command-bridge` user or its empty home/work directories. It still creates or retains the `command-bridge` group used by the unit to read administrator-owned policy files. After successful activation, real MCP/Audit verification and migration commitment, the installer detects an old user and removes it only if it is a local, non-root system account with the expected `/var/empty/command-bridge` home, nologin shell, primary group and no extra groups or active processes. The policy-reader group keeps its original GID even if `userdel` removes a same-name group automatically. The installing login account is never removed.

Unexpected identity settings or active processes block cleanup; no processes are killed. Activation failure keeps the old user available for rollback. If final account cleanup fails after commitment, installation returns an error while the newly verified service stays active; resolve the reported identity/process issue and repeat the same installer-account command to retry. Configuration, tokens, the empty old service home and historical work files are not deleted or recursively re-owned; those files retain their existing ownership metadata, which can show a numeric UID after account removal. Administrators can migrate individual historical files if needed. Default dedicated-account installations still create the service user they execute as.

No URL prompt is required. A fresh installation selects a private IPv4 address, preferring the default-route interface, and configures both the listener and allowed Host. It prints `http://<IP>:<port>/mcp` and the generated or preserved bearer token in a marked Codex setup block. Detection accepts RFC1918 and 100.64.0.0/10 addresses (including Tailscale); without one it falls back to `127.0.0.1`, usable only on this host. Existing configuration is preserved, and the printed URL uses its saved host and port. A wildcard IPv4 bind uses the detected private IP; a wildcard IPv6 bind prints IPv6 loopback for local setup.

To use an existing private HTTPS route instead:

```bash
(installer="$(mktemp)" && trap 'rm -f -- "${installer}"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${installer}" && sudo bash "${installer}" --print-codex-setup --codex-url "https://command-bridge.example.com/mcp")
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
5. Creates a unique temporary build account, runs `npm ci --ignore-scripts`, TypeScript compilation, and tests with a clean environment and distinct empty user/global npm configuration files, then freezes ownership and removes that account.
6. Stages any old program migration and installs immutable runtime and application release directories under `/usr/local/lib/command-bridge`, preserving originals until activation is verified.
7. Creates the low-privilege <code>command-bridge</code> account in default mode and a root-only environment file. In installer-account mode, it creates only the policy-reader group and uses the original sudo login account with separate private file-Audit state.
8. In default mode, verifies the pinned root-owned audit reader, installs it at <code>/usr/local/libexec/command-bridge/audit-reader</code>, validates the exact no-argument sudoers rule with <code>visudo</code>, and confirms the service account can read only this service's Audit JSON messages.
9. Enables and starts <code>command-bridge.service</code>.
10. Checks <code>/health</code> and authenticated <code>/ready</code>, executes hostname through a real MCP connection, and reads its matching Audit lifecycle. Failure restores the prior release, network configuration and audit-reader assets.
11. In installer-account mode, safely removes any recognized, unused old service user after verification; when explicitly requested, prints the copy-ready Codex configuration block.

## Long command timeouts

From 4.1.15, new configurations allow command requests up to 300 seconds, while omitted `timeoutMs` still uses 15 seconds. Codex setup prints `tool_timeout_sec = 360.0` so termination, Audit and response delivery have extra time. For a long command, request `timeoutMs: 300000`; values above the server maximum are clamped. Existing configured limits are preserved on reinstall: edit `COMMAND_BRIDGE_MAX_TIMEOUT_MS=300000` in the service configuration from an administrator terminal and restart the service. On the Codex client, update only this connection's existing `[mcp_servers.<name>]` section in `~/.codex/config.toml` to `tool_timeout_sec = 360`, preserving URL/token settings, then restart Codex. A client timeout alone does not establish whether the remote operation completed; inspect Audit before repeating an operation.

For an existing default installation, run from the host administrator terminal (then update Codex as described above):

```bash
sudo sed -i 's/^COMMAND_BRIDGE_MAX_TIMEOUT_MS=.*/COMMAND_BRIDGE_MAX_TIMEOUT_MS=300000/' /etc/command-bridge/command-bridge.env && sudo grep -qx 'COMMAND_BRIDGE_MAX_TIMEOUT_MS=300000' /etc/command-bridge/command-bridge.env && sudo systemctl restart command-bridge
```

If the key is absent or the configuration path is customized, add/update it in the actual service configuration before restarting. This does not change the default timeout or execution mode.

## Program relocation from /opt (4.6.0)

The fixed default application/runtime root is `/usr/local/lib/command-bridge`. Use the same bootstrap install and uninstall commands; no directory option or prior uninstall is required. Configuration, policy, work data, installer-account Audit and update records keep their existing locations. The service remains `command-bridge.service`; Windows paths are unchanged.

Before modifying services, the installer inspects the new root and both `/opt/command-bridge` and `/opt/command-bridge-mcp-server`. It validates administrator ownership, non-administrator write permissions, managed release identity, active pointers, mounted subtrees and any compatibility aliases. Two independent real deployments are rejected; no contents are merged. Destination free space is checked on the actual filesystem with room for the copied deployment and the new build. A directory change on the same filesystem does not increase free disk space.

The old program is copied into staging on the destination filesystem, so crossing filesystems is supported without destroying the original. Only managed active release/runtime pointers are rewritten; installed release contents are preserved. After service switching, authenticated readiness, real MCP `hostname`, matching Audit lifecycle, fixed diagnostics and CLI version must succeed. Updater/diagnostic assets, the unit, configuration and CLI pointer are restored on failure before restarting the original program. SELinux labels are restored and verified under the host policy without disabling SELinux or adding broad rules.

Successful migration replaces only existing old program roots with exact links to the new root, then removes the old physical program backup. Fresh installations create no `/opt` aliases. CLI and MCP updates preserve the existing service account, mode, network, token and policy; ordinary reinstall still selects mode from its arguments (the README explicitly selects guarded). The old independent update worker can finish its migration through the compatibility alias and record the resulting SHA.

An interrupted `.migration-backup` is rejected by installation for administrator recovery instead of guessing which deployment is active. Uninstall validates and removes managed backups as well as every verified new/old program root, including independent leftover trees. Unknown directories, unsafe permissions, escaping links and mounted deployment paths stop cleanup before service removal. Default uninstall preserves configuration, token and work/Audit/update records; only `--purge` removes data. It never deletes the installer login account.

The bootstrap prefers the installed uninstaller. After an older uninstaller completes, it checks all roots and managed assets rather than treating that one script's exit status as complete removal. If cleanup remains or the saved uninstaller is missing, it downloads the channel-pinned fallback and checks for remaining assets again. If the verified channel is still too old to remove them, it reports incomplete removal instead of claiming success; help and dry-run previews are exempt from removal assertions. No fallback to unverified main is permitted. See [validation status](validation-status.md) for local versus hosted evidence; service restart/enable checks are not host reboot or Oracle Linux Enforcing verification.

## Installed layout

Disposable-runner tests require evidence from the deployed test SHA before accepting an upgrade failure. They verify a changed loopback listener, restored configuration and source identity, preserved work data, and real MCP/Audit access after rollback. These checks do not replace actual reboot testing; see [validation status](validation-status.md) for executed results.

```text
/usr/local/lib/command-bridge/
├── current -> releases/v4.6.0-<source-sha>
├── releases/v4.6.0-<source-sha>/
└── runtime/
    ├── current -> node-v24.18.0-linux-{x64|arm64}
    └── node-v24.18.0-linux-{x64|arm64}/

/etc/command-bridge/
├── command-bridge.env                 root:root 0600
└── policy.json                        root:command-bridge 0640

/var/lib/command-bridge/
└── work/                              command-bridge:command-bridge 0750

/var/lib/command-bridge-installer/     installer account, 0700 (opt-in mode)
└── CommandBridgeMCP/audit/            private rotating JSONL files

/etc/systemd/system/
└── command-bridge.service
```

The application and Node.js runtime are owned by root. The default dedicated service account can write only to its state directory and private temporary directory under the default systemd policy. Installer-account mode uses the login account's normal filesystem access.

### Upgrading an existing 1.x Linux installation

Use the same one-line install command. The installer builds and tests the selected CI-verified source and validates the saved policy before it stops the old `command-bridge-mcp-server` service. It moves the application, configuration and work directories to the shorter paths, updates the two managed configuration paths (`COMMAND_BRIDGE_POLICY_FILE` and `COMMAND_BRIDGE_ALLOWED_ROOTS`), and leaves the old directory names as links to the moved data. The bearer token and other custom settings are preserved. It then verifies the new `command-bridge` service with a real MCP command and matching Audit records before disabling and removing the old unit.

If the new service fails validation, the installer stops it, restores the old directories, release and configuration, and restarts the old service. Existing automation should switch to `systemctl ... command-bridge` and `journalctl -u command-bridge`; the old service name is removed after a successful upgrade. The GitHub download URL and Codex MCP tool names do not change.

The earlier service's journal entries remain under `journalctl -u command-bridge-mcp-server`. The MCP Audit reader queries the current `command-bridge` service journal after migration.

The installer also creates these root-owned audit access assets:

- <code>/usr/local/libexec/command-bridge/audit-reader</code> (<code>root:root 0755</code>), a no-argument helper that reads the latest 1,001 service journal entries and uses a fixed filter to emit only CommandBridge Audit JSON. Empty journals succeed; journal read failures propagate through Bash pipefail. Unrelated service logs are not returned.
- <code>/etc/sudoers.d/command-bridge-audit-reader</code> (<code>root:root 0440</code>), which permits <code>command-bridge ALL=(root) NOPASSWD: /usr/local/libexec/command-bridge/audit-reader ""</code> and nothing else

The service account is not added to <code>sudo</code> or <code>systemd-journal</code> groups.

## Default configuration

### SELinux hosts and recovery from 203/EXEC

On SELinux Enforcing or Permissive hosts, `getenforce`, `restorecon` and `matchpathcon` must be available (Oracle Linux/RHEL packages: `policycoreutils` and `libselinux-utils`). The installer checks these tools before changing the deployment. Disabled/non-SELinux hosts do not need them. Missing tools, an unknown mode, or failed label restoration/verification stops activation with a concrete error.

Version 2.0.1 and earlier copied temporary SELinux labels into `/opt`; an Oracle Linux 8.10 report showed systemd denied execution of Node.js labeled `user_tmp_t`, producing `203/EXEC`. Version 2.0.2 began repairing final-path labels, but its recursive `restorecon -x` invocation fails on Oracle Linux 8.10 because that option is unavailable. Version 2.0.3 traverses the managed tree with `find -P -xdev`, passes each discovered path to `restorecon`, and verifies labels with `matchpathcon`. Existing runtimes are repaired before reuse. Rerun the same bootstrap after the corrected SHA is published to the channel; a full uninstall is unnecessary and the saved token/configuration/work data remain preserved.

Label repair uses host policy, including administrator-defined file-context mappings. It covers the managed application tree, configuration files, service unit and Audit assets. It does not follow application symlinks into external trees, cross mount points during recursive traversal, recursively relabel work data, disable SELinux, force a universal executable type, or generate allow rules. Rollback repairs restored paths before restarting the old service; a label failure is reported rather than claiming successful recovery. A remaining health failure reports bounded execution-file labels/permissions and mount type/noexec status, without dumping configuration or tokens.

For a **fresh disposable Oracle Linux 8.10 VM only**, install the development/test prerequisites and run from a project checkout:

```bash
sudo env COMMAND_BRIDGE_DISPOSABLE_VM=1 bash scripts/linux-systemd/tests/selinux-enforcing-smoke.sh
```

The script requires systemd PID 1, SELinux Enforcing, and no existing installation/account. It deliberately labels the installed Node.js `user_tmp_t`, requires an actual `203/EXEC`, then verifies repair through reinstall, a new snapshot upgrade, post-MCP/Audit failure rollback, configuration/data preservation and uninstall/purge. Failed test logs remain in a root-only temporary directory. It never changes SELinux mode. This script's existence and mocked unit tests are not evidence of an Enforcing VM pass; see [validation status](validation-status.md).

### Environment file

The installer generates `/etc/command-bridge/command-bridge.env` only when it does not already exist, and it never replaces an existing bearer token. It prints the token only when `--print-codex-setup` or `--codex-url` is explicitly supplied.

```dotenv
COMMAND_BRIDGE_TRANSPORT=http
COMMAND_BRIDGE_AUDIT_BACKEND=journal
COMMAND_BRIDGE_POLICY_FILE=/etc/command-bridge/policy.json
COMMAND_BRIDGE_BEARER_TOKEN=<generated-64-character-token>
COMMAND_BRIDGE_HTTP_HOST=<detected-private-ip-or-127.0.0.1>
COMMAND_BRIDGE_HTTP_PORT=8800
COMMAND_BRIDGE_ALLOWED_HOSTS=<selected-ip-for-non-loopback>
COMMAND_BRIDGE_EXECUTION_MODE=allowlist
COMMAND_BRIDGE_ALLOWED_SHELLS=bash
COMMAND_BRIDGE_ALLOWED_COMMANDS=uname,hostname,whoami,uptime,date,df,free,ps,pwd
COMMAND_BRIDGE_ALLOWED_ROOTS=/var/lib/command-bridge/work
COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS=15000
COMMAND_BRIDGE_MAX_TIMEOUT_MS=300000
COMMAND_BRIDGE_MAX_OUTPUT_CHARS=50000
COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS=2
COMMAND_BRIDGE_PASSTHROUGH_ENV=
```

Read the token locally as root:

```bash
sudo awk -F= '$1 == "COMMAND_BRIDGE_BEARER_TOKEN" { print substr($0, index($0, "=") + 1) }' /etc/command-bridge/command-bridge.env
```

## Copy-ready Codex setup

The output between `BEGIN COPY FOR CODEX` and `END COPY FOR CODEX` is a prompt, not a shell script. Copy the entire block into a trusted Codex task on the client machine. The Linux host name becomes a lowercase `cb_<hostname>` Codex connection name; separators become underscores. For example, `twtpelplmap06d` yields `[mcp_servers.cb_twtpelplmap06d]` and `CB_TWTPELPLMAP06D_TOKEN`. It tells Codex to:

1. Inspect the existing user-level `~/.codex/config.toml` and user environment before editing. If the suggested name or variable belongs to a different host, choose an unused name and corresponding uppercase `<NAME>_TOKEN`; do not overwrite the existing connection or token.
2. Persist the host's bearer token in that user environment variable on the Codex client; keep the secret out of TOML and source control.
3. Add the selected `[mcp_servers.<name>]` entry and point `bearer_token_env_var` at its matching variable.
4. Preserve unrelated settings, report restart requirements, and verify the named MCP connection after restart.

Add `--codex-name cb_oracle_prod` to the one-command installation to choose a stable client name; `--codex-name=cb_oracle_prod` is also accepted and implies setup output. A name must start with a lowercase letter and contain only lowercase letters, digits or underscores, up to 64 characters. It affects only the printed Codex setup; the Linux service remains `command-bridge`. The installer cannot inspect client-side names or environment variables, so collision resolution happens when Codex applies the block. Identical host names can produce the same suggestion. Renaming a host later changes the default suggestion, so choose an explicit name if you require a permanent alias.

`--codex-url` accepts only an HTTPS URL ending in `/mcp`, without embedded credentials, a query, or a fragment. When provided, a fresh install defaults to loopback for use behind a private HTTPS route. An explicit `COMMAND_BRIDGE_HTTP_HOST` overrides detection. For a concrete non-loopback host, allowed Hosts default to that host unless explicitly configured. Wildcard binds still require an explicit allowed Hosts list. Reinstallation preserves the bearer token and network settings unless `--refresh-network` is requested; switching to installer-account mode deliberately changes the Audit backend and working roots. The built-in listener does not provide TLS.

After editing the environment file, restart the service:

```bash
sudo systemctl restart command-bridge
```

## Service operations

```bash
sudo systemctl status command-bridge
sudo systemctl restart command-bridge
sudo systemctl stop command-bridge
sudo systemctl start command-bridge
sudo systemctl is-enabled command-bridge
sudo journalctl -u command-bridge -n 100 --no-pager
sudo journalctl -u command-bridge -f
# Replace HOST and PORT with the values in command-bridge.env:
curl -fsS http://HOST:PORT/health
```

## Audit log

For every <code>command_bridge_run_command</code> request, CommandBridge writes compact JSON to standard error before process start and after the terminal outcome. The systemd unit routes standard error to the service journal.

Host administrators can inspect the records with:

~~~bash
sudo journalctl --unit command-bridge.service --output=json --no-pager --lines 1000
sudo journalctl --unit command-bridge.service --no-pager --lines 100
~~~

Codex can call the read-only <code>command_bridge_list_audit_events</code> MCP tool with a <code>limit</code> from 1 through 1,000 (50 by default). For example, `{"limit":1000}` requests up to 1,000 recent events; `{}` keeps the default of 50. The fixed reader inspects a bounded recent journal window, so unrelated service entries can reduce the available Audit results. This is not pagination or a complete historical export. The existing five-second deadline and 4 MiB native-reader output limit remain in force; increasing the count does not repair an unavailable Audit backend. The server invokes only the installed fixed reader through non-interactive sudo; it cannot pass journal units, query strings, paths, or other arguments from the MCP client.

In installer-account mode, both writing and reading Audit events use the private file backend and require no Audit reader or sudoers rule. The service account owns the JSONL files, so it can modify or remove them; treat them as operational records, not tamper-proof evidence.

Each accepted event is redacted again before it is returned. Events contain audit ID, timestamp, phase, redacted command, shell, working directory, mode, source, exit code, duration, timeout/truncation, and error code. They never contain command output, bearer tokens, environment values, or raw secrets. The redactor cannot be disabled.

Journald retention is a host policy. This installer does not change global journal retention. The log is operational evidence, not a signed, immutable, or tamper-evident audit ledger.

## Uninstall

The default one-command uninstall stops and disables the service, removes <code>/etc/systemd/system/command-bridge.service</code>, removes the audit reader and its restricted sudoers file, reloads systemd, and deletes all verified program roots at <code>/usr/local/lib/command-bridge</code>, <code>/opt/command-bridge</code> and <code>/opt/command-bridge-mcp-server</code>, their managed migration backups and exact compatibility aliases:

```bash
(uninstaller="$(mktemp)" && trap 'rm -f -- "${uninstaller}"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --uninstall --yes)
```

It preserves these resources for a future reinstall:

- `/etc/command-bridge`, including the bearer token
- `/var/lib/command-bridge`, including all work data
- `/var/lib/command-bridge-installer`, including opt-in file Audit and work data when used
- Any existing `command-bridge` account, the policy-reader group, and `/var/empty/command-bridge` home; installer-account mode no longer has the dedicated user after successful cleanup

For review and a no-change preview:

```bash
curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o command-bridge-uninstall.sh
less command-bridge-uninstall.sh
sudo bash command-bridge-uninstall.sh --uninstall --dry-run
sudo bash command-bridge-uninstall.sh --uninstall --yes
```

For a permanent full purge:

> [!CAUTION]
> This deletes the bearer token, configuration, all CommandBridge work and file Audit data, and the dedicated `command-bridge` service identity. It never deletes the installer login account or its home. The uninstaller refuses to delete the dedicated identity when its home, shell, group membership, or running processes do not match the expected low-privilege service account.

```bash
(uninstaller="$(mktemp)" && trap 'rm -f -- "${uninstaller}"' EXIT && curl -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/main/scripts/bootstrap.sh -o "${uninstaller}" && sudo bash "${uninstaller}" --uninstall --purge --yes)
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

The default service is a low-privilege diagnostic agent, not a root shell. Its account has no login shell, Docker access, or supplementary groups. It has exact no-argument sudoers permissions for the root-owned Audit reader, diagnostics and updater; it has no generic sudo command access. Commands such as <code>systemctl restart</code>, package installation, firewall changes, and arbitrary file modification are intentionally unavailable.

Installer-account mode is a different trust choice: the unit runs as the login user, keeps its ordinary groups and access, and uses file Audit instead of the privileged reader. With `--unrestricted`, it can execute the account's shell commands, including `sudo -n` operations already permitted by host policy. No general sudo rights are granted; fixed diagnostic and update permissions are installed separately. Losing or changing ordinary sudo rights changes command behavior as well.

The controlled reader requires a sudo privilege transition, so the systemd unit cannot use <code>NoNewPrivileges=true</code> or <code>RestrictSUIDSGID=true</code>. Do not change that exception into broad sudo access or add the service account to privileged groups.

Since 1.0.4, the capability ceiling retains only `CAP_SETUID CAP_SETGID` so sudo can perform the authorized identity transition. `AmbientCapabilities` remains empty: the non-root Node process and ordinary commands do not receive those capabilities. Clearing the entire ceiling prevents native Audit startup.

The unit also omits settings that implicitly enable `NoNewPrivileges` for this non-root service: PrivateDevices, ProtectHostname/Clock/KernelTunables/KernelModules/KernelLogs, RestrictRealtime/Namespaces/AddressFamilies, LockPersonality and SystemCallArchitectures. These syscall restrictions are not active. `DevicePolicy=closed` limits device access; read-only system/home mounts, private temporary storage, control-group protection, resource limits, the capability ceiling and the exact sudo rule remain. Do not re-enable incompatible settings without replacing the sudo-based Audit design and verifying real MCP/Audit access.

`COMMAND_BRIDGE_ALLOWED_ROOTS` restricts the command working directory. It does not stop an allowed command from naming another readable path as an argument. The real boundary is the service account plus the systemd filesystem and capability restrictions.

If a future workflow needs one privileged operation, add a purpose-built helper or narrowly scoped Polkit rule. Do not run the general MCP server as root and do not add its account to the Docker group.

## Reinstall and upgrade behavior

Running the same verified installer again is idempotent: it reuses the pinned runtime and release, preserves configuration, reloads the unit, and rechecks service health.

Future versions will use their own versioned release directory. The installer records the current application and runtime symlinks before activation. If the new process cannot become active and pass `/health`, the symlinks are restored and the previous service is restarted.

The source build is pinned to a full commit SHA and npm lockfile. The Node.js archive is checksum-verified. A future release artifact workflow will add a separately checksummed, prebuilt offline bundle so hosts do not need to compile source during installation.

## 1.0 migration and reliability

See [the migration guide](migration-1.0.md) for custom native policies, audit backends, authenticated readiness, installation identity, and --refresh-network. The installer checks existing policies before switching releases and verifies a real MCP command plus its audit ID before completing activation. The saved uninstaller is current/uninstall.sh; install-info.json records the version, source SHA and runtime.

## Optional file transfer (3.1.0)

Upload/download are disabled by default and independent of unrestricted mode. See [secure file transfer](file-transfer.md) for opt-in installer flags, private directories, 5 MiB limits, no-overwrite behavior and Audit/failure handling. Omitted transfer flags preserve existing transfer settings; edit the saved environment settings to disable.

## Command preflight self-protection (4.0.0)

Recognizable direct self-maintenance commands are rejected before execution in all modes. Existing sudo remains available; no broker, privilege ceiling or read-only OS isolation is added. Use a separate administrator terminal for CommandBridge configuration/program/service changes. This is accidental-command prevention, not protection from arbitrary root code. See [the guard and migration guide](self-protection.md) for supported patterns, path checks, false positives and bypass limits.

## Optional guarded mode (4.1.0)

Use `--guarded` (optionally with `--run-as-installer`) to permit general commands while rejecting recognizable deletion and system changes. Existing sudo/OS permissions remain unchanged; arbitrary scripts/programs can bypass this accident guard. The README installation commands select guarded from 4.1.2. See [rules, mode selection and limitations](guarded-mode.md).

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

## Independent MCP diagnostics (4.5.0)

`command_bridge_get_diagnostics` is enabled by default and shares the existing Bearer/Host checks. See [diagnostics and recovery](diagnostics.md) for field meanings, volatile history, strict bounds and Audit-only startup. No configuration flag or ordinary command/sudo policy change is required. Older installations need an upgrade before the tool exists.

Both dedicated and installer-account installations provision `/usr/local/libexec/command-bridge-diagnostics/{reader,reader.mjs}` and `/etc/sudoers.d/command-bridge-diagnostics`. Programs are pinned to source digests, root-owned, not writable by the service, and restored to host SELinux policy. The exact numeric service UID may run only the no-argument reader with `NOSETENV`. It reads fixed `command-bridge.service` metadata, the last 100 journal entries for known diagnostic codes, and fixed deployment/work/storage metadata; it returns no raw log messages. It does not grant generic journal/root access or replace the existing Audit reader. Installer-account file Audit still needs no privileged Audit reader.

New assets and the previous authorization are backed up before changes and restored before restarting the old deployment after activation failure. The installer verifies the running fixed reader through MCP in addition to readiness, hostname and its Audit lifecycle. Normal uninstall and purge remove the diagnostic program and rule; preserved configuration/work/Audit behavior is unchanged. A diagnostic-only service is not accepted as a successful installation. CI fixtures check no-argument authorization and uninstall cleanup; hosted lifecycle checks must still execute before publication.
