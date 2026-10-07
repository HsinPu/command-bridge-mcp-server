#!/usr/bin/env bash
# Root-only destructive lifecycle test, exclusively for an empty disposable VM.
# Does not change SELinux mode or install policy exceptions.
set -Eeuo pipefail
[[ ${EUID} == 0 && ${COMMAND_BRIDGE_DISPOSABLE_VM:-} == 1 ]] || { echo 'Explicit disposable VM opt-in and root are required.' >&2; exit 1; }
[[ "$(getenforce)" == Enforcing && "$(ps -p 1 -o comm=)" == systemd ]] || { echo 'SELinux Enforcing and systemd PID 1 are required.' >&2; exit 1; }
for path in /usr/local/lib/command-bridge /etc/command-bridge /var/lib/command-bridge \
    /opt/command-bridge-mcp-server /etc/command-bridge-mcp-server /var/lib/command-bridge-mcp-server \
    /etc/systemd/system/command-bridge.service /etc/systemd/system/command-bridge-mcp-server.service \
    /usr/local/libexec/command-bridge /etc/sudoers.d/command-bridge-audit-reader; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Empty VM required; found $path" >&2; exit 1; }
done
! getent passwd command-bridge >/dev/null || { echo 'Existing service account; refusing test.' >&2; exit 1; }
root=$(pwd)
work=$(mktemp -d /tmp/command-bridge-selinux-smoke.XXXXXX)
trap 'code=$?; if (( code == 0 )); then rm -rf -- "$work"; else printf "SELinux smoke failed. Private logs retained at %s\n" "$work" >&2; fi' EXIT
mkdir "$work/base" "$work/candidate"
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env -cf - . | tar -C "$work/base" -xf -
sha=3333333333333333333333333333333333333333
printf '%s\n' "$sha" > "$work/base/.command-bridge-source-sha"
export COMMAND_BRIDGE_HTTP_HOST=127.0.0.1
bash "$work/base/scripts/linux-systemd/install.sh" > "$work/fresh.log" 2>&1
node=/usr/local/lib/command-bridge/runtime/current/bin/node
config=/etc/command-bridge/command-bridge.env
verify_service() {
  [[ "$(getenforce)" == Enforcing ]]
  systemctl is-active --quiet command-bridge
  systemctl is-enabled --quiet command-bridge
  "$node" "$root/scripts/tests/wait-for-listener.mjs" "$config"
  "$node" /usr/local/lib/command-bridge/current/scripts/verify-install.mjs "$config"
  matchpathcon -V "$(readlink -f "$node")" >/dev/null
}
verify_service
printf 'preserved\n' > /var/lib/command-bridge/work/preserved
config_hash=$(sha256sum "$config")
old=$(readlink /usr/local/lib/command-bridge/current)
old_info=$(sha256sum /usr/local/lib/command-bridge/current/install-info.json)

# Reproduce the reported failure, then repair the SAME runtime via reinstall.
systemctl stop command-bridge
chcon -t user_tmp_t "$(readlink -f "$node")"
systemctl start command-bridge || true
denied=0
for ((attempt=0; attempt<20; attempt++)); do
  if [[ "$(systemctl show command-bridge -p ExecMainStatus --value)" == 203 ]]; then denied=1; break; fi
  sleep 0.2
done
systemctl stop command-bridge
[[ "$denied" == 1 ]] || { echo 'Failed to reproduce 203/EXEC with user_tmp_t.' >&2; exit 1; }
systemctl reset-failed command-bridge
bash "$work/base/scripts/linux-systemd/install.sh" > "$work/reinstall.log" 2>&1
verify_service
[[ "$(sha256sum "$config")" == "$config_hash" ]]

# A real post-activation MCP/Audit success precedes the injected upgrade failure.
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.env -cf - . | tar -C "$work/candidate" -xf -
fault_sha=4444444444444444444444444444444444444444
marker=/var/lib/command-bridge/work/selinux-verified.json
"$node" scripts/tests/rollback-fixture.mjs prepare "$work/candidate" verify "$fault_sha" "$marker" 127.0.0.2
if bash "$work/candidate/scripts/linux-systemd/install.sh" --refresh-network > "$work/rollback.log" 2>&1; then
  echo 'Expected injected upgrade failure.' >&2; exit 1
fi
grep -q INJECTED_POST_ACTIVATION_FAILURE "$work/rollback.log"
"$node" scripts/tests/rollback-fixture.mjs assert "$marker" "$fault_sha" verified
[[ "$(readlink /usr/local/lib/command-bridge/current)" == "$old" ]]
[[ "$(sha256sum /usr/local/lib/command-bridge/current/install-info.json)" == "$old_info" ]]
[[ "$(sha256sum "$config")" == "$config_hash" ]]
grep -Fxq preserved /var/lib/command-bridge/work/preserved
verify_service

# A different verified snapshot upgrades successfully with preserved data.
printf '%s\n' 5555555555555555555555555555555555555555 > "$work/base/.command-bridge-source-sha"
bash "$work/base/scripts/linux-systemd/install.sh" > "$work/upgrade.log" 2>&1
[[ "$(readlink /usr/local/lib/command-bridge/current)" != "$old" ]]
verify_service
[[ "$(sha256sum "$config")" == "$config_hash" ]]
bash /usr/local/lib/command-bridge/current/uninstall.sh --yes > "$work/uninstall.log" 2>&1
test -f "$config"
grep -Fxq preserved /var/lib/command-bridge/work/preserved
bash "$work/base/scripts/linux-systemd/install.sh" > "$work/reinstall-after-uninstall.log" 2>&1
verify_service
bash /usr/local/lib/command-bridge/current/uninstall.sh --purge --yes > "$work/purge.log" 2>&1
[[ ! -e /usr/local/lib/command-bridge && ! -e /etc/command-bridge && ! -e /var/lib/command-bridge ]]
[[ "$(getenforce)" == Enforcing ]]
echo 'Enforcing: reproduced 203/EXEC, repaired reused runtime, verified fresh install, upgrade, rollback, MCP/Audit and purge.'
