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
stage=setup
failed_line=unknown
trap 'failed_line=$LINENO' ERR
finish() {
  local code=$?
  if ((code)); then
    echo "Layout smoke failed: mode=${mode:-setup}, stage=$stage, line=$failed_line." >&2
    sudo systemctl show command-bridge command-bridge-update --property=ActiveState,SubState,Result >&2 || true
    echo "Test evidence retained at $work" >&2
    if [[ "$stage" == fault-* && -n "${fault:-}" && -f "$work/fault-$mode-$fault.log" ]]; then tail -n 40 "$work/fault-$mode-$fault.log" >&2; fi
  else
    sudo rm -rf --one-file-system -- "$work"
  fi
  if getent passwd "$account" >/dev/null; then sudo userdel "$account" || true; fi
  exit "$code"
}
trap finish EXIT
for path in "$new_root" "$old_root" /opt/command-bridge-mcp-server /etc/command-bridge /etc/command-bridge-mcp-server /var/lib/command-bridge /var/lib/command-bridge-installer /var/lib/command-bridge-recovery; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Disposable test requires an empty path: $path"; exit 1; }
done
bash scripts/linux-systemd/tests/prepare-disposable-host.sh
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
  stage=old-installation
  install_old() { sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$work/old/scripts/linux-systemd/install.sh" "${flags[@]}"; }
  install_old > "$work/old-$mode.log" 2>&1 || { tail -n 30 "$work/old-$mode.log"; exit 1; }
  stage=old-layout-verification
  sudo systemctl is-active --quiet command-bridge
  sudo "$old_root/runtime/current/bin/node" "$old_root/current/scripts/verify-install.mjs" "$config"
  old_target=$(readlink "$old_root/current")
  info_hash=$(sudo sha256sum "$old_root/current/install-info.json" | cut -d' ' -f1)
  config_hash=$(sudo sha256sum "$config" | cut -d' ' -f1)
  data_root=$(sudo awk -F= '$1 == "COMMAND_BRIDGE_ALLOWED_ROOTS" { print substr($0, index($0, "=") + 1) }' "$config")
  data_root=${data_root%%:*}
  # The CI caller cannot traverse dedicated/fixture-account private data.
  sudo test -d "$data_root"
  sudo touch "$data_root/layout-preserved"
  asset_hash=$(sudo sha256sum /usr/local/libexec/command-bridge-update/request /etc/systemd/system/command-bridge-update.service)
  [[ ! -e /usr/local/libexec/command-bridge-diagnostics && ! -e /etc/sudoers.d/command-bridge-diagnostics ]]
  # A legacy saved uninstaller must not stop the real old service before the
  # channel's full-layout preflight rejects an unknown new program directory.
  stage=legacy-uninstall-preflight
  preflight_archive="$work/preflight-$mode.tar.gz"
  tar -C "$work" -czf "$preflight_archive" new
  node --input-type=module - "$root" "$preflight_archive" "$version" "$work/preflight-$mode.sh" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,archive,version,out]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(out,fixtureBootstrap(readFileSync(root+'/scripts/bootstrap.sh','utf8'),'linux','b'.repeat(40),version,archive));
JS
  sudo mkdir -- "$new_root"
  sudo touch "$new_root/layout-foreign-fixture"
  if sudo bash "$work/preflight-$mode.sh" --uninstall --yes > "$work/preflight-$mode.log" 2>&1; then echo 'Expected unknown program root rejection'; exit 1; fi
  grep -q 'No managed release identity' "$work/preflight-$mode.log"
  sudo systemctl is-active --quiet command-bridge
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" && "$(sudo sha256sum "$old_root/current/install-info.json" | cut -d' ' -f1)" == "$info_hash" ]]
  [[ "$(sudo sha256sum /usr/local/libexec/command-bridge-update/request /etc/systemd/system/command-bridge-update.service)" == "$asset_hash" ]]
  sudo test -f "$new_root/layout-foreign-fixture"
  sudo test -f "$data_root/layout-preserved"
  sudo "$old_root/runtime/current/bin/node" "$old_root/current/scripts/verify-install.mjs" "$config"
  sudo rm -- "$new_root/layout-foreign-fixture"
  sudo rmdir -- "$new_root"
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
    stage="fault-$fault"
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
  stage=legacy-managed-update-rejection
  target_sha=$(printf '%040d' "$([[ "$mode" == dedicated ]] && echo 4 || echo 5)")
  archive="$work/update-$mode.tar.gz"
  tar -C "$work" -czf "$archive" new
  # Use the existing fixture to replace only downloads in the OLD saved bootstrap.
  # Its cached /opt path cannot survive removal, so require a pre-mutation refusal.
  sudo "$test_node" --input-type=module - "$root" "$old_root/current/bootstrap.sh" "$archive" "$version" "$target_sha" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [root,path,archive,version,sha]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(path,fixtureBootstrap(readFileSync(path,'utf8'),'linux',sha,version,archive));
JS
  sudo env GITHUB_ACTIONS=true "$test_node" scripts/tests/verify-managed-update.mjs "$config" "$target_sha" --expect-layout-migration-rejection
  assert_restored
  stage=terminal-migration
  # The saved CLI bootstrap is copied outside the deployment before its removal.
  sudo cp "$old_root/current/bootstrap.sh" "$work/terminal-update-$mode.sh"
  sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$work/terminal-update-$mode.sh" --update > "$work/terminal-update-$mode.log" 2>&1 || { tail -n 30 "$work/terminal-update-$mode.log"; exit 1; }
  [[ -d "$new_root" && ! -L "$new_root" ]]
  for path in "$old_root" /opt/command-bridge-mcp-server; do [[ ! -e "$path" && ! -L "$path" && ! -e "$path.migration-backup" ]]; done
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  sudo test -f "$data_root/layout-preserved"
  sudo "$new_root/runtime/current/bin/node" "$new_root/current/scripts/verify-install.mjs" "$config"
  [[ "$(/usr/local/bin/command-bridge --version)" == "$version" ]]
  # Model 4.6.x aliases on an already-migrated host. A subsequent MCP update
  # uses the new path, removes both aliases, and records the actual resulting SHA.
  stage=managed-update-with-old-aliases
  sudo ln -s "$new_root" "$old_root"
  sudo ln -s "$old_root" /opt/command-bridge-mcp-server
  target_sha=$(printf '%040d' "$([[ "$mode" == dedicated ]] && echo 2 || echo 3)")
  sudo "$test_node" --input-type=module - "$root" "$new_root/current/bootstrap.sh" "$archive" "$version" "$target_sha" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,path,archive,version,sha]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(path,fixtureBootstrap(readFileSync(path,'utf8'),'linux',sha,version,archive));
JS
  sudo env GITHUB_ACTIONS=true "$test_node" scripts/tests/verify-managed-update.mjs "$config" "$target_sha"
  for path in "$old_root" /opt/command-bridge-mcp-server; do [[ ! -e "$path" && ! -L "$path" && ! -e "$path.migration-backup" ]]; done
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  sudo test -f "$data_root/layout-preserved"
  # Create verified old program leftovers; uninstall must inspect all three roots.
  stage=rollback-storage-failure
  recovery_fixture="$work/recovery-$mode"; mkdir "$recovery_fixture"
  cp -a "$work/new/." "$recovery_fixture/"
  recovery_sha=$(printf '%040d' "$([[ "$mode" == dedicated ]] && echo 12 || echo 13)")
  recovery_marker="$data_root/recovery-$mode.json"
  sudo test ! -e "$recovery_marker"
  node scripts/tests/recovery-fixture.mjs prepare "$recovery_fixture" "$recovery_sha" "$recovery_marker"
  if sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$recovery_fixture/scripts/linux-systemd/install.sh" "${flags[@]}" > "$work/recovery-$mode.log" 2>&1; then echo 'Expected incomplete recovery'; exit 1; fi
  grep -q INJECTED_RECOVERY_FAILURE "$work/recovery-$mode.log"
  grep -q 'Rollback is incomplete' "$work/recovery-$mode.log"
  sudo "$test_node" scripts/tests/recovery-fixture.mjs assert "$recovery_marker" "$recovery_sha"
  if sudo systemctl is-active --quiet command-bridge; then echo 'Incomplete recovery restarted service'; exit 1; fi
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  retained=$(sudo find /var/lib/command-bridge-recovery -mindepth 1 -maxdepth 1 -type d -name 'failed.*' -print)
  sudo test -f "$retained/snapshots/update-assets-backup/complete"
  if sudo env SUDO_USER="$account" SUDO_UID="$account_uid" SUDO_GID="$account_gid" bash "$work/new/scripts/linux-systemd/install.sh" "${flags[@]}" > "$work/pending-$mode.log" 2>&1; then echo 'Pending recovery ignored'; exit 1; fi
  grep -q 'Incomplete installer recovery exists' "$work/pending-$mode.log"
  # Model explicit administrator recovery using the unmodified fixed module.
  sudo bash -c 'source "$1/install.sh"; trap - EXIT ERR; source "$1/managed-update.sh"; detect_selinux; MANAGED_UPDATE_BACKUP="$2/snapshots/update-assets-backup"; restore_managed_update_assets' _ "$work/new/scripts/linux-systemd" "$retained"
  sudo systemctl restart command-bridge
  sudo "$test_node" scripts/tests/wait-for-listener.mjs "$config"
  sudo "$new_root/runtime/current/bin/node" "$new_root/current/scripts/verify-install.mjs" "$config"
  [[ "$(sudo "$test_node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).sourceSha' "$new_root/current/install-info.json")" == "$target_sha" ]]
  sudo test -f "$data_root/layout-preserved"
  stage=complete-uninstall
  sudo cp -a --no-preserve=context "$new_root" "$old_root"
  sudo cp -a --no-preserve=context "$new_root" /opt/command-bridge-mcp-server
  node --input-type=module - "$root" "$archive" "$version" "$target_sha" "$work/bootstrap.sh" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,archive,version,sha,out]=process.argv.slice(2);
const {fixtureBootstrap}=await import(pathToFileURL(root+'/scripts/tests/managed-update-fixture.mjs'));
writeFileSync(out,fixtureBootstrap(readFileSync(root+'/scripts/bootstrap.sh','utf8'),'linux',sha,version,archive));
JS
  if [[ "$mode" == installer ]]; then
    # Keep coverage for an absent saved uninstaller without removing the service.
    sudo cp -p "$new_root/current/uninstall.sh" "$work/saved-uninstall.sh"
    sudo rm -- "$new_root/current/uninstall.sh"
    sudo bash "$work/bootstrap.sh" --uninstall --dry-run --yes > "$work/uninstall-preview-$mode.log" 2>&1 || { tail -n 30 "$work/uninstall-preview-$mode.log"; exit 1; }
    sudo systemctl is-active --quiet command-bridge
    [[ -d "$new_root" && "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
    sudo test -f "$data_root/layout-preserved"
    sudo cp -p "$work/saved-uninstall.sh" "$new_root/current/uninstall.sh"
    # A present uninstaller with its required helper missing must use the
    # SHA-pinned fallback before stopping services or removing program roots.
    sudo rm -- "$new_root/current/layout.sh"
  fi
  sudo bash "$work/bootstrap.sh" --uninstall --yes > "$work/uninstall-$mode.log" 2>&1 || { tail -n 30 "$work/uninstall-$mode.log"; exit 1; }
  if [[ "$mode" == installer ]]; then grep -Fq 'Installed layout helper is missing; using the verified channel uninstaller.' "$work/uninstall-$mode.log"; fi
  for path in "$new_root" "$old_root" /opt/command-bridge-mcp-server; do [[ ! -e "$path" && ! -L "$path" ]]; done
  [[ "$(sudo sha256sum "$config" | cut -d' ' -f1)" == "$config_hash" ]]
  sudo test -f "$data_root/layout-preserved"
  sudo test -f "$retained/snapshots/update-assets-backup/complete"
  stage=purge
  sudo bash "$work/bootstrap.sh" --uninstall --purge --yes > "$work/purge-$mode.log" 2>&1 || { tail -n 30 "$work/purge-$mode.log"; exit 1; }
  for path in /etc/command-bridge /var/lib/command-bridge /var/lib/command-bridge-installer /var/lib/command-bridge-update /var/lib/command-bridge-recovery; do sudo test ! -e "$path"; done
  getent passwd "$account" >/dev/null
  echo "Real $mode migration, activation evidence, rollback, MCP update and complete uninstall passed."
done
