#!/usr/bin/env bash
# Keep the original program intact until the new service has passed verification.
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
  [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]] || return 0
  local i
  if [[ -d "$APP_BACKUP_PATH" && ! -L "$APP_BACKUP_PATH" ]]; then
    [[ -L "$APP_ORIGINAL_ROOT" && "$(readlink "$APP_ORIGINAL_ROOT")" == "$INSTALL_ROOT" ]] || return 1
    unlink "$APP_ORIGINAL_ROOT" || return 1
    mv -T -- "$APP_BACKUP_PATH" "$APP_ORIGINAL_ROOT" || return 1
  fi
  for (( i=0; i<${#APP_ALIAS_NAMES[@]}; i++ )); do
    ln -sfnT "${APP_ALIAS_TARGETS[i]}" "${APP_ALIAS_NAMES[i]}" || return 1
  done
  if [[ "${APP_MIGRATION_PREPARED:-0}" == 1 ]]; then
    assert_admin_path "$INSTALL_ROOT"
    assert_no_program_mounts "$INSTALL_ROOT"
    rm -rf --one-file-system -- "$INSTALL_ROOT" || return 1
  fi
  cleanup_application_staging || return 1
  APP_MIGRATION_STARTED=0
  APP_MIGRATION_PREPARED=0
}

commit_application_layout() {
  [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]] || return 0
  local alias
  [[ "$(readlink -f "$APP_ORIGINAL_ROOT/current")" == "$APP_ORIGINAL_RELEASE" &&
     "$(readlink -f "$APP_ORIGINAL_ROOT/runtime/current")" == "$APP_ORIGINAL_RUNTIME" ]] || fail "Original deployment changed during migration."
  # Remember the previous 1.x -> /opt alias as well, so failures can restore it.
  while IFS= read -r alias; do
    if [[ -L "$alias" && "$alias" != "$APP_ORIGINAL_ROOT" ]]; then
      assert_layout_alias "$alias"
      APP_ALIAS_NAMES+=("$alias"); APP_ALIAS_TARGETS+=("$(readlink "$alias")")
    fi
  done < <(layout_roots)
  [[ ! -e "$APP_BACKUP_PATH" && ! -L "$APP_BACKUP_PATH" ]] || fail "Migration backup path already exists."
  mv -T -- "$APP_ORIGINAL_ROOT" "$APP_BACKUP_PATH"
  # If alias creation fails, restore the directory immediately before normal rollback.
  if ! ln -sT "$INSTALL_ROOT" "$APP_ORIGINAL_ROOT"; then
    mv -T -- "$APP_BACKUP_PATH" "$APP_ORIGINAL_ROOT" || true
    fail "Cannot create the compatibility alias."
  fi
  for alias in "${APP_ALIAS_NAMES[@]}"; do ln -sfnT "$INSTALL_ROOT" "$alias"; done
  restore_selinux_path "$APP_ORIGINAL_ROOT" || fail "Cannot label the compatibility alias."
}

finish_application_migration() {
  [[ "${APP_MIGRATION_STARTED:-0}" == 1 ]] || return 0
  [[ "$INSTALL_SUCCEEDED" == 1 && "$ACTIVATION_STARTED" == 0 && "$APP_BACKUP_PATH" == "$APP_ORIGINAL_ROOT.migration-backup" ]] || fail "Refusing cleanup before migration commitment."
  assert_managed_program_tree "$APP_BACKUP_PATH"
  rm -rf --one-file-system -- "$APP_BACKUP_PATH" || fail "The new service is verified, but migration backup cleanup failed."
  APP_MIGRATION_STARTED=0
  log "Migration complete; the old program was removed and its path is a compatibility alias."
}
