#!/bin/bash
# Real services on an explicitly disposable Linux environment; never production.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || { echo 'Disposable test environment required.' >&2; exit 1; }
root=$(pwd)
test_node=$(command -v node)
old_root=/opt/command-bridge
new_root=/usr/local/lib/command-bridge
config=/etc/command-bridge/command-bridge.env
old_sha=f0e16711289f83468059f7f803fe6f426d45ef02
work=$(mktemp -d /var/tmp/command-bridge-layout-smoke.XXXXXX)
account="cb-layout-$$"
finish() {
  local code=$?
  if ((code)); then
    sudo systemctl show command-bridge command-bridge-update --property=ActiveState,SubState,Result >&2 || true
    echo "Test evidence retained at $work" >&2
    if [[ -n "${fault:-}" && -f "$work/fault-$mode-$fault.log" ]]; then tail -n 40 "$work/fault-$mode-$fault.log" >&2; fi
  else
    sudo rm -rf --one-file-system -- "$work"
  fi
  if getent passwd "$account" >/dev/null; then sudo userdel "$account" || true; fi
  exit "$code"
}
trap finish EXIT
for path in "$new_root" "$old_root" /opt/command-bridge-mcp-server /etc/command-bridge /etc/command-bridge-mcp-server /var/lib/command-bridge /var/lib/command-bridge-installer; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Disposable test requires an empty path: $path"; exit 1; }
done
# Hosted runners have writable /usr/local parents. Prepare only this disposable host.
sudo chown root:root /usr/local /usr/local/bin /usr/local/lib
sudo chmod 0755 /usr/local /usr/local/bin /usr/local/lib
mkdir "$work/old" "$work/new"
curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/HsinPu/command-bridge-mcp-server/archive/$old_sha.tar.gz" -o "$work/old.tar.gz"
tar -xzf "$work/old.tar.gz" -C "$work/old" --strip-components=1
printf '%s\n' "$old_sha" > "$work/old/.command-bridge-source-sha"
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude='*.tmp.*' -cf - . | tar -C "$work/new" -xf -
version=$(node -p 'require("./package.json").version')
sudo useradd --home-dir "$work/home" --shell /bin/bash --no-create-home "$account"
sudo install -d -m 0750 -o "$account" -g "$account" "$work/home"
# The account can traverse its home but cannot write the test snapshots.
chmod 0755 "$work"
account_uid=$(id -u "$account"); account_gid=$(id -g "$account")
for mode in ${LAYOUT_TEST_MODES:-dedicated installer}; do
  [[ "$mode" == dedicated || "$mode" == installer ]] || { echo 'Unknown disposable test mode.'; exit 1; }
  flags=()
  if [[ "$mode" == installer ]]; then flags=(--run-as-installer --guarded); fi
  install_old() { sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$work/old/scripts/linux-systemd/install.sh" "${flags[@]}"; }
  install_old > "$work/old-$mode.log" 2>&1 || { tail -n 30 "$work/old-$mode.log"; exit 1; }
  sudo systemctl is-active --quiet command-bridge
  sudo "$old_root/runtime/current/bin/node" "$old_root/current/scripts/verify-install.mjs" "$config"
  old_target=$(readlink "$old_root/current")
  info_hash=$(sudo sha256sum "$old_root/current/install-info.json" | cut -d' ' -f1)
  config_hash=$(sudo sha256sum "$config" | cut -d' ' -f1)
  data_root=$(sudo awk -F= '$1 == "COMMAND_BRIDGE_ALLOWED_ROOTS" { print substr($0, index($0, "=") + 1) }' "$config")
  data_root=${data_root%%:*}
  [[ -d "$data_root" ]]
  sudo touch "$data_root/layout-preserved"
  asset_hash=$(sudo sha256sum /usr/local/libexec/command-bridge-update/request /etc/systemd/system/command-bridge-update.service)
  [[ ! -e /usr/local/libexec/command-bridge-diagnostics && ! -e /etc/sudoers.d/command-bridge-diagnostics ]]
  assert_restored() {
    [[ -d "$old_root" && ! -L "$old_root" && ! -e "$new_root" && ! -L "$new_root" ]]
    [[ "$(readlink "$old_root/current")" == "$old_target" && "$(sudo sha256sum "$old_root/current/install-info.json" | cut -d' ' -f1)" == "$info_hash" ]]
    [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
    [[ "$(sudo sha256sum /usr/local/libexec/command-bridge-update/request /etc/systemd/system/command-bridge-update.service)" == "$asset_hash" ]]
    [[ ! -e /usr/local/libexec/command-bridge-diagnostics && ! -e /etc/sudoers.d/command-bridge-diagnostics ]]
    sudo systemctl is-active --quiet command-bridge
    sudo "$old_root/runtime/current/bin/node" "$old_root/current/scripts/verify-install.mjs" "$config"
  }
  for fault in health verify; do
    fixture="$work/fault-$mode-$fault"; mkdir "$fixture"
    cp -a "$work/new/." "$fixture/"
    if [[ "$mode" == dedicated ]]; then digit=6; else digit=7; fi
    [[ "$fault" != verify ]] || digit=$((digit+2))
    fault_sha=$(printf '%040d' "$digit")
    marker="/var/lib/command-bridge/work/layout-$mode-$fault.json"
    if [[ "$mode" == installer ]]; then marker="/var/lib/command-bridge-installer/layout-$mode-$fault.json"; fi
    if [[ "$fault" == verify ]]; then
      node scripts/tests/rollback-fixture.mjs prepare "$fixture" verify "$fault_sha" "$marker" 127.0.0.2
      fault_flags=(--refresh-network)
    else
      node scripts/tests/rollback-fixture.mjs prepare "$fixture" health "$fault_sha" "$marker"
      fault_flags=()
    fi
    if sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$fixture/scripts/linux-systemd/install.sh" "${flags[@]}" "${fault_flags[@]}" > "$work/fault-$mode-$fault.log" 2>&1; then echo 'Expected injected migration failure'; exit 1; fi
    if [[ "$fault" == verify ]]; then
      grep -q INJECTED_POST_ACTIVATION_FAILURE "$work/fault-$mode-$fault.log"
      sudo "$test_node" scripts/tests/rollback-fixture.mjs assert "$marker" "$fault_sha" verified
    else
      grep -q INJECTED_STARTUP_FAILURE "$work/fault-$mode-$fault.log"
      sudo "$test_node" scripts/tests/rollback-fixture.mjs assert "$marker" "$fault_sha" started
    fi
    assert_restored
  done
  target_sha=$(printf '%040d' "$([[ "$mode" == dedicated ]] && echo 4 || echo 5)")
  archive="$work/update-$mode.tar.gz"
  tar -C "$work" -czf "$archive" new
  # Use the existing fixture to replace only downloads in the OLD saved bootstrap.
  # This exercises the old privileged worker through migration and its final record.
  sudo "$test_node" --input-type=module - "$root" "$old_root/current/bootstrap.sh" "$archive" "$version" "$target_sha" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [root,path,archive,version,sha]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(path,fixtureBootstrap(readFileSync(path,'utf8'),'linux',sha,version,archive));
JS
  sudo env GITHUB_ACTIONS=true "$test_node" scripts/tests/verify-managed-update.mjs "$config" "$target_sha"
  [[ -d "$new_root" && ! -L "$new_root" && "$(readlink "$old_root")" == "$new_root" && ! -e "$old_root.migration-backup" ]]
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  sudo test -f "$data_root/layout-preserved"
  sudo "$new_root/runtime/current/bin/node" "$new_root/current/scripts/verify-install.mjs" "$config"
  [[ "$(command-bridge --version)" == "$version" ]]
  # Create verified old program leftovers; uninstall must inspect all three roots.
  sudo unlink "$old_root"
  sudo cp -a --no-preserve=context "$new_root" "$old_root"
  sudo cp -a --no-preserve=context "$new_root" /opt/command-bridge-mcp-server
  node --input-type=module - "$root" "$archive" "$version" "$target_sha" "$work/bootstrap.sh" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,archive,version,sha,out]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(out,fixtureBootstrap(readFileSync(root+'/scripts/bootstrap.sh','utf8'),'linux',sha,version,archive));
JS
  if [[ "$mode" == installer ]]; then
    # Missing saved uninstallers exercises the SHA-pinned fallback.
    sudo rm -- "$new_root/current/uninstall.sh"
  fi
  sudo bash "$work/bootstrap.sh" --uninstall --yes > "$work/uninstall-$mode.log" 2>&1 || { tail -n 30 "$work/uninstall-$mode.log"; exit 1; }
  for path in "$new_root" "$old_root" /opt/command-bridge-mcp-server; do [[ ! -e "$path" && ! -L "$path" ]]; done
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  sudo test -f "$data_root/layout-preserved"
  sudo bash "$work/bootstrap.sh" --uninstall --purge --yes > "$work/purge-$mode.log" 2>&1 || { tail -n 30 "$work/purge-$mode.log"; exit 1; }
  for path in /etc/command-bridge /var/lib/command-bridge /var/lib/command-bridge-installer /var/lib/command-bridge-update; do sudo test ! -e "$path"; done
  getent passwd "$account" >/dev/null
  echo "Real $mode migration, activation evidence, rollback, MCP update and complete uninstall passed."
done
