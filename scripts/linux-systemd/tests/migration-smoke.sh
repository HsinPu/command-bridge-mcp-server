#!/usr/bin/env bash
# Run only on a disposable CI VM after the fresh-install service smoke test.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || { echo 'Disposable GitHub runner required.' >&2; exit 1; }
root=$(pwd)
old_sha=a2cb503005d9fe5ea2f7447c8af4bc1b88380843
old_service=command-bridge-mcp-server
new_service=command-bridge
old_config=/etc/command-bridge-mcp-server/command-bridge.env
new_config=/etc/command-bridge/command-bridge.env
work=$(mktemp -d)
trap 'code=$?; if (( code != 0 )); then sudo systemctl show "$old_service" "$new_service" --property=ActiveState,SubState,Result >&2 || true; fi; rm -rf -- "$work"' EXIT
for path in /usr/local/lib/command-bridge /opt/command-bridge /opt/command-bridge-mcp-server /etc/command-bridge /etc/command-bridge-mcp-server /var/lib/command-bridge /var/lib/command-bridge-mcp-server; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Test requires an empty installation: $path" >&2; exit 1; }
done
! getent passwd command-bridge >/dev/null
mkdir "$work/old" "$work/candidate"
curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/HsinPu/command-bridge-mcp-server/archive/${old_sha}.tar.gz" -o "$work/old.tar.gz"
tar -xzf "$work/old.tar.gz" -C "$work/old" --strip-components=1
printf '%s\n' "$old_sha" > "$work/old/.command-bridge-source-sha"
sudo bash "$work/old/scripts/linux-systemd/install.sh" > "$work/old-install.log" 2>&1 || { tail -n 30 "$work/old-install.log"; exit 1; }
sudo systemctl is-active --quiet "$old_service"
sudo systemctl is-enabled --quiet "$old_service"
old_config_hash=$(sudo sha256sum "$old_config" | awk '{ print $1 }')
old_policy_hash=$(sudo sha256sum /etc/command-bridge-mcp-server/policy.json | awk '{ print $1 }')
old_token=$(sudo awk -F= '$1 == "COMMAND_BRIDGE_BEARER_TOKEN" { print substr($0, index($0, "=") + 1) }' "$old_config")
[[ ${#old_token} -ge 32 ]]
sudo touch /var/lib/command-bridge-mcp-server/work/preserved

tar --exclude=.git --exclude=node_modules --exclude=dist --exclude='*.tmp.*' -cf - . | tar -C "$work/candidate" -xf -
marker=/var/lib/command-bridge-mcp-server/work/migration-verified.json
new_host=127.0.0.2
[[ "$(sudo awk -F= '$1 == "COMMAND_BRIDGE_HTTP_HOST" { print $2 }' "$old_config")" != "$new_host" ]] || new_host=127.0.0.1
fault_sha=$(printf '%040d' 4)
sudo /opt/command-bridge-mcp-server/runtime/current/bin/node "$root/scripts/tests/rollback-fixture.mjs" prepare "$work/candidate" verify "$fault_sha" "$marker" "$new_host"
if sudo bash "$work/candidate/scripts/linux-systemd/install.sh" --refresh-network > "$work/failure.log" 2>&1; then echo 'Expected migration verification failure.' >&2; exit 1; fi
grep -q 'INJECTED_POST_ACTIVATION_FAILURE' "$work/failure.log"
sudo /opt/command-bridge-mcp-server/runtime/current/bin/node "$root/scripts/tests/rollback-fixture.mjs" assert "$marker" "$fault_sha" verified
[[ "$(sudo sha256sum "$old_config" | awk '{ print $1 }')" == "$old_config_hash" ]]
[[ "$(sudo sha256sum /etc/command-bridge-mcp-server/policy.json | awk '{ print $1 }')" == "$old_policy_hash" ]]
sudo systemctl is-active --quiet "$old_service"
! sudo systemctl is-active --quiet "$new_service"
[[ -d /opt/command-bridge-mcp-server && ! -L /opt/command-bridge-mcp-server ]]
[[ ! -e /usr/local/lib/command-bridge && ! -L /usr/local/lib/command-bridge ]]
sudo test -f /var/lib/command-bridge-mcp-server/work/preserved
sudo /opt/command-bridge-mcp-server/runtime/current/bin/node /opt/command-bridge-mcp-server/current/scripts/verify-install.mjs "$old_config"

sudo bash "$root/scripts/linux-systemd/install.sh" > "$work/new-install.log" 2>&1 || { tail -n 40 "$work/new-install.log"; exit 1; }
sudo systemctl is-active --quiet "$new_service"
sudo systemctl is-enabled --quiet "$new_service"
[[ ! -e /etc/systemd/system/command-bridge-mcp-server.service ]]
[[ ! -e /etc/sudoers.d/command-bridge-mcp-server-audit-reader ]]
[[ ! -e /usr/local/libexec/command-bridge-mcp-server/audit-reader ]]
for pair in '/opt/command-bridge-mcp-server /usr/local/lib/command-bridge' '/etc/command-bridge-mcp-server /etc/command-bridge' '/var/lib/command-bridge-mcp-server /var/lib/command-bridge'; do
  read -r old new <<< "$pair"
  [[ "$(readlink "$old")" == "$new" ]]
done
[[ "$(sudo awk -F= '$1 == "COMMAND_BRIDGE_BEARER_TOKEN" { print substr($0, index($0, "=") + 1) }' "$new_config")" == "$old_token" ]]
[[ "$(sudo sha256sum /etc/command-bridge/policy.json | awk '{ print $1 }')" == "$old_policy_hash" ]]
sudo grep -Fxq 'COMMAND_BRIDGE_POLICY_FILE=/etc/command-bridge/policy.json' "$new_config"
sudo grep -Fxq 'COMMAND_BRIDGE_ALLOWED_ROOTS=/var/lib/command-bridge/work' "$new_config"
sudo test -f /var/lib/command-bridge/work/preserved
sudo /usr/local/lib/command-bridge/runtime/current/bin/node /usr/local/lib/command-bridge/current/scripts/verify-install.mjs "$new_config"
sudo bash /usr/local/lib/command-bridge/current/uninstall.sh --purge --yes > "$work/uninstall.log" 2>&1 || { tail -n 30 "$work/uninstall.log"; exit 1; }
for path in /usr/local/lib/command-bridge /opt/command-bridge-mcp-server /etc/command-bridge /etc/command-bridge-mcp-server /var/lib/command-bridge /var/lib/command-bridge-mcp-server; do
  [[ ! -e "$path" && ! -L "$path" ]]
done
echo 'Linux 1.0.5 migration, failure rollback, MCP/Audit and purge passed.'
