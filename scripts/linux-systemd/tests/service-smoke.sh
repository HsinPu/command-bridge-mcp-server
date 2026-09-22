#!/usr/bin/env bash
# Run only on a disposable CI VM: installs and removes the real service.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || { echo 'Disposable GitHub runner required.' >&2; exit 1; }
root=$(pwd)
config=/etc/command-bridge-mcp-server/command-bridge.env
service=command-bridge-mcp-server
fixture=$(mktemp -d)
verify_log=$(mktemp)
health_log=$(mktemp)
trap 'rm -rf -- "$fixture"; rm -f -- "$verify_log" "$health_log"' EXIT
sudo bash scripts/linux-systemd/install.sh
sudo systemctl is-active --quiet "$service"
sudo systemctl is-enabled --quiet "$service"
before=$(sudo sha256sum "$config")
sudo touch /var/lib/command-bridge-mcp-server/work/preserved
sudo bash scripts/linux-systemd/install.sh
[[ "$(sudo sha256sum "$config")" == "$before" ]]
sudo bash scripts/linux-systemd/install.sh --refresh-network >/dev/null
sudo systemctl restart "$service"
sudo /opt/command-bridge-mcp-server/runtime/current/bin/node /opt/command-bridge-mcp-server/current/scripts/verify-install.mjs "$config"
old=$(readlink /opt/command-bridge-mcp-server/current)
node=/opt/command-bridge-mcp-server/runtime/current/bin/node
work=/var/lib/command-bridge-mcp-server/work
before_refresh=$(sudo sha256sum "$config")
old_info=$(sudo sha256sum /opt/command-bridge-mcp-server/current/install-info.json)
host=$(sudo awk -F= '$1 == "COMMAND_BRIDGE_HTTP_HOST" { print $2 }' "$config")
new_host=127.0.0.1
[[ "$host" != "$new_host" ]] || new_host=127.0.0.2
verify_sha=$(printf '%040d' 1)
health_sha=$(printf '%040d' 2)
verify_marker="$work/rollback-verify-$RANDOM.json"
health_marker="$work/rollback-health-$RANDOM.json"
assert_restored() {
  [[ "$(readlink /opt/command-bridge-mcp-server/current)" == "$old" ]]
  [[ "$(sudo sha256sum /opt/command-bridge-mcp-server/current/install-info.json)" == "$old_info" ]]
  [[ "$(sudo sha256sum "$config")" == "$before_refresh" ]]
  sudo test -f "$work/preserved"
  sudo systemctl is-active --quiet "$service"
  sudo "$node" /opt/command-bridge-mcp-server/current/scripts/verify-install.mjs "$config"
}
tar --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$fixture" -xf -
sudo "$node" scripts/tests/rollback-fixture.mjs prepare "$fixture" verify "$verify_sha" "$verify_marker" "$new_host"
if sudo bash "$fixture/scripts/linux-systemd/install.sh" --refresh-network > "$verify_log" 2>&1; then echo 'Expected verification failure.'; exit 1; fi
grep -q 'INJECTED_POST_ACTIVATION_FAILURE' "$verify_log"
sudo "$node" scripts/tests/rollback-fixture.mjs assert "$verify_marker" "$verify_sha" verified
assert_restored
cp "$root/scripts/verify-install.mjs" "$fixture/scripts/verify-install.mjs"
sudo "$node" scripts/tests/rollback-fixture.mjs prepare "$fixture" health "$health_sha" "$health_marker"
if sudo bash "$fixture/scripts/linux-systemd/install.sh" > "$health_log" 2>&1; then echo 'Expected service health failure.'; exit 1; fi
sudo "$node" scripts/tests/rollback-fixture.mjs assert "$health_marker" "$health_sha" started
assert_restored
sudo cp "$config" "$config.backup"
sudo sed -i 's/^COMMAND_BRIDGE_ALLOWED_COMMANDS=.*/COMMAND_BRIDGE_ALLOWED_COMMANDS=unknown-custom-command/' "$config"
if sudo bash "$root/scripts/linux-systemd/install.sh"; then echo 'Expected migration rejection.'; exit 1; fi
[[ "$(readlink /opt/command-bridge-mcp-server/current)" == "$old" ]]
sudo mv "$config.backup" "$config"
sudo bash /opt/command-bridge-mcp-server/current/uninstall.sh --yes
sudo test -f "$config"
sudo test -f /var/lib/command-bridge-mcp-server/work/preserved
sudo bash "$root/scripts/linux-systemd/install.sh"
sudo bash /opt/command-bridge-mcp-server/current/uninstall.sh --purge --yes
[[ ! -e /opt/command-bridge-mcp-server ]]
sudo test ! -e "$config"
