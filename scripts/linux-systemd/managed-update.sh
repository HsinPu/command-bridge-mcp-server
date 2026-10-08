#!/usr/bin/env bash
# Sourced by the installer; paths and operation names are deliberately fixed.
assert_managed_update_directory() {
  local path=$1 mode
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" && "$(stat -c %u "$path")" == 0 ]] || fail "Unsafe managed update directory."
    mode=$(stat -c %a "$path")
    (( (8#$mode & 022) == 0 )) || fail "Managed update directory is writable by non-administrators."
  fi
}

prepare_managed_update_state() {
  assert_managed_update_directory /var/lib/command-bridge-update
  install -d -m 2750 -o root -g command-bridge /var/lib/command-bridge-update
  restore_selinux_path /var/lib/command-bridge-update || fail "Cannot label update state."
}

restore_managed_update_assets() {
  [[ -n "${MANAGED_UPDATE_BACKUP:-}" ]] || return 0
  [[ -d "$MANAGED_UPDATE_BACKUP" ]] || return 1
  restore_asset_group "$MANAGED_UPDATE_BACKUP" /usr/local/libexec/command-bridge-update/request /usr/local/libexec/command-bridge-update/state.mjs /etc/systemd/system/command-bridge-update.service /etc/sudoers.d/command-bridge-update || return 1
  if [[ -f "$MANAGED_UPDATE_BACKUP/new-directory" && -e /usr/local/libexec/command-bridge-update ]]; then rmdir /usr/local/libexec/command-bridge-update || return 1; fi
  systemctl daemon-reload || return 1
  MANAGED_UPDATE_BACKUP=
}

install_managed_update() {
  local asset_root=/usr/local/libexec/command-bridge-update source_dir="${TEMP_DIR}/source" target name update_uid
  require_command visudo
  assert_managed_update_directory /usr/local/libexec
  assert_managed_update_directory "$asset_root"
  local backup="$TEMP_DIR/recovery/update-assets-backup"
  assert_managed_update_directory /etc/systemd/system
  assert_managed_update_directory /etc/sudoers.d
  backup_asset_group "$backup" "$asset_root/request" "$asset_root/state.mjs" /etc/systemd/system/command-bridge-update.service /etc/sudoers.d/command-bridge-update || fail "Managed update asset validation or backup failed; original assets were preserved."
  if [[ ! -d "$asset_root" ]]; then touch "$backup/new-directory"; fi
  MANAGED_UPDATE_BACKUP=$backup
  if [[ ! -d "$asset_root" ]]; then install -d -m 0755 -o root -g root "$asset_root"; fi
  mark_asset_change "$backup" "$asset_root/request"
  install -m 0755 -o root -g root "$source_dir/packaging/linux/update-request" "$asset_root/request"
  mark_asset_change "$backup" "$asset_root/state.mjs"
  install -m 0644 -o root -g root "$source_dir/scripts/managed-update/state.mjs" "$asset_root/state.mjs"
  mark_asset_change "$backup" /etc/systemd/system/command-bridge-update.service
  install -m 0644 -o root -g root "$source_dir/packaging/systemd/command-bridge-update.service" /etc/systemd/system/command-bridge-update.service
  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then update_uid=${INSTALLER_UID}; else update_uid=$(id -u command-bridge); fi
  [[ "$update_uid" =~ ^[0-9]+$ && "$update_uid" != 0 ]] || fail "Invalid managed update UID."
  printf '#%s ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/command-bridge-update/request ""\n' "$update_uid" > "$TEMP_DIR/update-sudoers"
  visudo -cf "$TEMP_DIR/update-sudoers" >/dev/null || fail "Invalid managed update sudo rule."
  mark_asset_change "$backup" /etc/sudoers.d/command-bridge-update
  install -m 0440 -o root -g root "$TEMP_DIR/update-sudoers" /etc/sudoers.d/command-bridge-update
  for target in "$asset_root" /etc/systemd/system/command-bridge-update.service /etc/sudoers.d/command-bridge-update; do
    if [[ "$target" == "$asset_root" ]]; then restore_selinux_path "$target" 1; else restore_selinux_path "$target"; fi || fail "Cannot label managed update assets."
  done
  systemctl daemon-reload
  systemctl show command-bridge-update.service --property=LoadState --value | grep -Fxq loaded || fail "Managed update unit did not load."
}
