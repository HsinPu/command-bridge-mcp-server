#!/usr/bin/env bash
# Run only on a disposable CI VM: installs and removes the real service.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || { echo 'Disposable GitHub runner required.' >&2; exit 1; }
root=$(pwd)
config=/etc/command-bridge-mcp-server/command-bridge.env
service=command-bridge-mcp-server
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
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
tar --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$fixture" -xf -
printf '%040d\n' 1 > "$fixture/.command-bridge-source-sha"
printf 'throw new Error("Injected verification failure");\n' > "$fixture/scripts/verify-install.mjs"
before_refresh=$(sudo sha256sum "$config")
if sudo bash "$fixture/scripts/linux-systemd/install.sh" --refresh-network; then echo 'Expected verification failure.'; exit 1; fi
[[ "$(sudo sha256sum "$config")" == "$before_refresh" ]]
[[ "$(readlink /opt/command-bridge-mcp-server/current)" == "$old" ]]
sudo systemctl is-active --quiet "$service"
sudo /opt/command-bridge-mcp-server/runtime/current/bin/node /opt/command-bridge-mcp-server/current/scripts/verify-install.mjs "$config"
cp "$root/scripts/verify-install.mjs" "$fixture/scripts/verify-install.mjs"
printf '%040d\n' 2 > "$fixture/.command-bridge-source-sha"
printf 'process.exit(1);\n' > "$fixture/src/index.ts"
if sudo bash "$fixture/scripts/linux-systemd/install.sh"; then echo 'Expected service health failure.'; exit 1; fi
[[ "$(readlink /opt/command-bridge-mcp-server/current)" == "$old" ]]
sudo systemctl is-active --quiet "$service"
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
