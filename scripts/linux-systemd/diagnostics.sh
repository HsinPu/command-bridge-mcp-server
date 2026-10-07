#!/usr/bin/env bash
# Sourced by install.sh. No caller-selected resources or arguments.
restore_diagnostic_assets() {
  [[ -n "${DIAGNOSTIC_BACKUP:-}" && -d "$DIAGNOSTIC_BACKUP" ]] || return 0
  local target name asset_root=/usr/local/libexec/command-bridge-diagnostics
  for target in "$asset_root/reader" "$asset_root/reader.mjs" /etc/sudoers.d/command-bridge-diagnostics; do
    name=$(basename "$target")
    if [[ -f "$DIAGNOSTIC_BACKUP/$name" ]]; then
      cp -p "$DIAGNOSTIC_BACKUP/$name" "$target" || return 1
      restore_selinux_path "$target" || return 1
    else
      rm -f -- "$target" || return 1
    fi
  done
  if [[ -f "$DIAGNOSTIC_BACKUP/new-directory" ]]; then rmdir -- "$asset_root" || return 1; fi
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
  # Validate every old asset before changing anything, including its write permissions.
  for target in "$asset_root/reader" "$asset_root/reader.mjs" /etc/sudoers.d/command-bridge-diagnostics; do
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" && "$(stat -c %u "$target")" == 0 ]] || fail "Unsafe diagnostic reader asset."
      local mode; mode=$(stat -c %a "$target")
      (( (8#$mode & 022) == 0 )) || fail "Writable diagnostic reader asset."
    fi
  done
  DIAGNOSTIC_BACKUP="$TEMP_DIR/diagnostic-assets-backup"
  install -d -m 0700 "$DIAGNOSTIC_BACKUP"
  if [[ ! -d "$asset_root" ]]; then touch "$DIAGNOSTIC_BACKUP/new-directory"; fi
  for target in "$asset_root/reader" "$asset_root/reader.mjs" /etc/sudoers.d/command-bridge-diagnostics; do
    if [[ -f "$target" ]]; then name=$(basename "$target"); cp -p "$target" "$DIAGNOSTIC_BACKUP/$name"; fi
  done
  install -d -m 0755 -o root -g root "$asset_root"
  install -m 0755 -o root -g root "$source_dir/packaging/linux/diagnostic-reader" "$asset_root/reader"
  install -m 0644 -o root -g root "$source_dir/scripts/diagnostics/read-linux.mjs" "$asset_root/reader.mjs"
  install -m 0440 -o root -g root "$TEMP_DIR/diagnostic-sudoers" /etc/sudoers.d/command-bridge-diagnostics
  restore_selinux_path "$asset_root" 1 || fail "Cannot label diagnostic reader."
  restore_selinux_path /etc/sudoers.d/command-bridge-diagnostics || fail "Cannot label diagnostic sudo rule."
}
