#!/usr/bin/env bash
# Keep the original program intact until the new service has passed verification.
assert_application_migration_driver() {
  [[ -n "$EXISTING_APP_ROOT" && "$EXISTING_APP_ROOT" != "$INSTALL_ROOT" ]] || return 0
  local state
  state=$(systemctl show command-bridge-update.service --property=ActiveState --value) || fail "Cannot determine legacy update worker state; no deployment changes were made."
  case "$state" in
    inactive|failed) ;;
    active|activating|deactivating)
      fail "Legacy MCP update cannot remove its own program path; use the administrator terminal installer or sudo command-bridge update after this task finishes."
      ;;
    *) fail "Unexpected legacy update worker state; no deployment changes were made." ;;
  esac
}

prepare_application_migration() {
  [[ -n "$EXISTING_APP_ROOT" && "$EXISTING_APP_ROOT" != "$INSTALL_ROOT" ]] || return 0
  APP_MIGRATION_STARTED=1
  APP_ORIGINAL_ROOT=$EXISTING_APP_ROOT
  APP_ORIGINAL_RELEASE=$(readlink -f "$EXISTING_APP_ROOT/current")
  APP_ORIGINAL_RUNTIME=$(readlink -f "$EXISTING_APP_ROOT/runtime/current")
  APP_BACKUP_PATH="$EXISTING_APP_ROOT.migration-backup"
  assert_admin_path "$(dirname "$INSTALL_ROOT")"
  install -d -m 0755 -o root -g root "$(dirname "$INSTALL_ROOT")"
  APP_MIGRATION_STAGING=$(mktemp -d "$(dirname "$INSTALL_ROOT")/.command-bridge-migrate.XXXXXX")
  cp -a --no-preserve=context "$EXISTING_APP_ROOT/." "$APP_MIGRATION_STAGING/" || fail "Program migration copy failed; the original deployment was preserved."
  # Only the two installer-managed pointers are rewritten. Release content stays immutable.
  ln -sfnT "$INSTALL_ROOT${APP_ORIGINAL_RELEASE#"$EXISTING_APP_ROOT"}" "$APP_MIGRATION_STAGING/current"
  ln -sfnT "$INSTALL_ROOT${APP_ORIGINAL_RUNTIME#"$EXISTING_APP_ROOT"}" "$APP_MIGRATION_STAGING/runtime/current"
  [[ ! -e "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] || fail "Migration destination changed during preparation."
  mv -T -- "$APP_MIGRATION_STAGING" "$INSTALL_ROOT"
  APP_MIGRATION_STAGING=
  APP_MIGRATION_PREPARED=1
  restore_current_selinux_layout || fail "Cannot label the migrated deployment."
  log "Prepared migration from $EXISTING_APP_ROOT to $INSTALL_ROOT; the original program is still intact."
}

cleanup_application_staging() {
  if [[ -n "${APP_MIGRATION_STAGING:-}" ]]; then
    [[ "$APP_MIGRATION_STAGING" == "$(dirname "$INSTALL_ROOT")/.command-bridge-migrate."* && ! -L "$APP_MIGRATION_STAGING" ]] || return 1
    rm -rf --one-file-system -- "$APP_MIGRATION_STAGING" || return 1
    APP_MIGRATION_STAGING=
  fi
}

rollback_application_layout() {
  local i
  if [[ "${APP_MIGRATION_STARTED:-0}" == 1 && -d "$APP_BACKUP_PATH" && ! -L "$APP_BACKUP_PATH" ]]; then
    [[ ! -e "$APP_ORIGINAL_ROOT" && ! -L "$APP_ORIGINAL_ROOT" ]] || return 1
    mv -T -- "$APP_BACKUP_PATH" "$APP_ORIGINAL_ROOT" || return 1
  fi
  for (( i=0; i<${#APP_ALIAS_NAMES[@]}; i++ )); do
    if [[ ! -e "${APP_ALIAS_NAMES[i]}" && ! -L "${APP_ALIAS_NAMES[i]}" ]]; then
      ln -sT "${APP_ALIAS_TARGETS[i]}" "${APP_ALIAS_NAMES[i]}" || return 1
    elif [[ ! -L "${APP_ALIAS_NAMES[i]}" || "$(readlink "${APP_ALIAS_NAMES[i]}")" != "${APP_ALIAS_TARGETS[i]}" ]]; then
      return 1
    fi
  done
  if [[ "${APP_MIGRATION_PREPARED:-0}" == 1 ]]; then
    assert_admin_path "$INSTALL_ROOT"
    assert_no_program_mounts "$INSTALL_ROOT"
    rm -rf --one-file-system -- "$INSTALL_ROOT" || return 1
  fi
  cleanup_application_staging || return 1
  APP_MIGRATION_STARTED=0
  APP_MIGRATION_PREPARED=0
  APP_ALIAS_NAMES=(); APP_ALIAS_TARGETS=()
}

commit_application_layout() {
  local alias
  if [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]]; then
    [[ "$(readlink -f "$APP_ORIGINAL_ROOT/current")" == "$APP_ORIGINAL_RELEASE" &&
       "$(readlink -f "$APP_ORIGINAL_ROOT/runtime/current")" == "$APP_ORIGINAL_RUNTIME" ]] || fail "Original deployment changed during migration."
  fi
  # Include aliases left by 4.6.x when the physical deployment is already new.
  # Validate every alias before renaming or unlinking any program path.
  while IFS= read -r alias; do
    if [[ "$alias" != "$INSTALL_ROOT" && -L "$alias" ]]; then
      assert_layout_alias "$alias"
      APP_ALIAS_NAMES+=("$alias"); APP_ALIAS_TARGETS+=("$(readlink "$alias")")
    fi
  done < <(layout_roots)
  if [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]]; then
    [[ ! -e "$APP_BACKUP_PATH" && ! -L "$APP_BACKUP_PATH" ]] || fail "Migration backup path already exists."
    mv -T -- "$APP_ORIGINAL_ROOT" "$APP_BACKUP_PATH"
  fi
  for alias in "${APP_ALIAS_NAMES[@]}"; do unlink "$alias" || fail "Cannot remove the old program alias."; done
}

finish_application_migration() {
  local root
  [[ "$INSTALL_SUCCEEDED" == 1 && "$ACTIVATION_STARTED" == 0 ]] || fail "Refusing cleanup before migration commitment."
  if [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]]; then
    [[ "$APP_BACKUP_PATH" == "$APP_ORIGINAL_ROOT.migration-backup" ]] || fail "Unexpected migration backup path."
    assert_managed_program_tree "$APP_BACKUP_PATH"
    rm -rf --one-file-system -- "$APP_BACKUP_PATH" || fail "The new service is verified, but migration backup cleanup failed."
  fi
  while IFS= read -r root; do
    [[ "$root" != "$INSTALL_ROOT" ]] || continue
    [[ ! -e "$root" && ! -L "$root" && ! -e "$root.migration-backup" && ! -L "$root.migration-backup" ]] || fail "The new service is verified, but an old program path remains."
  done < <(layout_roots)
  APP_MIGRATION_STARTED=0
  APP_MIGRATION_PREPARED=0
  APP_ALIAS_NAMES=(); APP_ALIAS_TARGETS=()
  log "Program layout verified; old program paths were removed without compatibility aliases."
}
