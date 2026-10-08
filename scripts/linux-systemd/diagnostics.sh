#!/usr/bin/env bash
# Sourced by install.sh. No caller-selected resources or arguments.
restore_diagnostic_assets() {
  [[ -n "${DIAGNOSTIC_BACKUP:-}" ]] || return 0
  [[ -d "$DIAGNOSTIC_BACKUP" ]] || return 1
  local asset_root=/usr/local/libexec/command-bridge-diagnostics
  restore_asset_group "$DIAGNOSTIC_BACKUP" "$asset_root/reader" "$asset_root/reader.mjs" /etc/sudoers.d/command-bridge-diagnostics || return 1
  if [[ -f "$DIAGNOSTIC_BACKUP/new-directory" && -e "$asset_root" ]]; then rmdir -- "$asset_root" || return 1; fi
  DIAGNOSTIC_BACKUP=
}

install_diagnostic_assets() {
  local asset_root=/usr/local/libexec/command-bridge-diagnostics source_dir="$TEMP_DIR/source" target name diagnostic_uid
  require_command visudo
  for target in /usr/local/libexec /etc/sudoers.d "$asset_root"; do assert_managed_update_directory "$target"; done
  if [[ "$RUN_AS_INSTALLER" == 1 ]]; then diagnostic_uid=$INSTALLER_UID; else diagnostic_uid=$(id -u command-bridge); fi
  [[ "$diagnostic_uid" =~ ^[0-9]+$ && "$diagnostic_uid" != 0 ]] || fail "Invalid diagnostic reader UID."
  printf '#%s ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/command-bridge-diagnostics/reader ""\n' "$diagnostic_uid" > "$TEMP_DIR/diagnostic-sudoers"
  visudo -cf "$TEMP_DIR/diagnostic-sudoers" >/dev/null || fail "Invalid diagnostic reader sudo rule."
  local backup="$TEMP_DIR/recovery/diagnostic-assets-backup"
  backup_asset_group "$backup" "$asset_root/reader" "$asset_root/reader.mjs" /etc/sudoers.d/command-bridge-diagnostics || fail "Diagnostic asset validation or backup failed; original assets were preserved."
  if [[ ! -d "$asset_root" ]]; then touch "$backup/new-directory"; fi
  DIAGNOSTIC_BACKUP=$backup
  if [[ ! -d "$asset_root" ]]; then install -d -m 0755 -o root -g root "$asset_root"; fi
  mark_asset_change "$backup" "$asset_root/reader"
  install -m 0755 -o root -g root "$source_dir/packaging/linux/diagnostic-reader" "$asset_root/reader"
  mark_asset_change "$backup" "$asset_root/reader.mjs"
  install -m 0644 -o root -g root "$source_dir/scripts/diagnostics/read-linux.mjs" "$asset_root/reader.mjs"
  mark_asset_change "$backup" /etc/sudoers.d/command-bridge-diagnostics
  install -m 0440 -o root -g root "$TEMP_DIR/diagnostic-sudoers" /etc/sudoers.d/command-bridge-diagnostics
  restore_selinux_path "$asset_root" 1 || fail "Cannot label diagnostic reader."
  restore_selinux_path /etc/sudoers.d/command-bridge-diagnostics || fail "Cannot label diagnostic sudo rule."
}
