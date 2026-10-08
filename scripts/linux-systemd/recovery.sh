#!/usr/bin/env bash
# Internal transaction snapshots. Never infer original absence from missing data.
RECOVERY_FAILED=0
RECOVERY_RETAINED=0
readonly RECOVERY_ROOT=/var/lib/command-bridge-recovery

save_file_backup() {
  local source=$1 backup=$2 metadata digest
  [[ -f "$source" && ! -L "$source" ]] || return 1
  install -d -m 0700 -- "$TEMP_DIR/recovery" || return 1
  install -d -m 0700 -- "${backup%/*}" || return 1
  metadata=$(stat -c '%u:%g:%a' -- "$source") || return 1
  digest=$(sha256sum -- "$source") || return 1
  digest=${digest%% *}
  # Publish the pointer only after copying and verifying every byte. A partial
  # destination must never become an eligible rollback snapshot.
  cp -p -- "$source" "$backup.partial" || return 1
  cmp -s -- "$source" "$backup.partial" || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$source")" == "$metadata" ]] || return 1
  [[ "$(sha256sum -- "$backup.partial")" == "$digest "* ]] || return 1
  chmod 0600 -- "$backup.partial" || return 1
  printf '%s\n' "$source" > "$backup.target" || return 1
  chmod 0600 -- "$backup.target" || return 1
  printf '%s\n%s\n' "$metadata" "$digest" > "$backup.info" || return 1
  chmod 0600 -- "$backup.info" || return 1
  mv -T -- "$backup.partial" "$backup" || return 1
}

restore_file_backup() {
  local backup=$1 target=$2 metadata digest uid gid mode staging
  [[ -f "$backup" && ! -L "$backup" && -f "$backup.info" && ! -L "$backup.info" && -f "$backup.target" && ! -L "$backup.target" ]] || return 1
  [[ "$(cat "$backup.target")" == "$target" ]] || return 1
  { IFS= read -r metadata; IFS= read -r digest; } < "$backup.info" || return 1
  [[ "$metadata" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ && "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$(sha256sum -- "$backup")" == "$digest "* ]] || return 1
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || return 1
  IFS=: read -r uid gid mode <<< "$metadata"
  staging=$(mktemp "${target%/*}/.command-bridge-restore.XXXXXX") || return 1
  if ! cp -- "$backup" "$staging" || ! cmp -s -- "$backup" "$staging" ||
     ! chown "$uid:$gid" "$staging" || ! chmod "$mode" "$staging" ||
     ! mv -Tf -- "$staging" "$target"; then
    rm -f -- "$staging" || true
    return 1
  fi
  restore_selinux_path "$target" || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$target")" == "$metadata" ]] || return 1
}

backup_asset_group() {
  local backup=$1 target name mode
  shift
  # Validate the entire set before taking any snapshots or changing directories.
  for target in "$@"; do
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" && "$(stat -c %u "$target")" == 0 ]] || return 1
      mode=$(stat -c %a "$target") || return 1
      (( (8#$mode & 022) == 0 )) || return 1
    fi
  done
  install -d -m 0700 -- "$backup" || return 1
  for target in "$@"; do
    name=${target##*/}
    if [[ -f "$target" ]]; then
      save_file_backup "$target" "$backup/$name" || return 1
      printf 'present\n' > "$backup/$name.state" || return 1
    else
      printf 'absent\n' > "$backup/$name.state" || return 1
    fi
    printf '%s\n' "$target" > "$backup/$name.target" || return 1
  done
  touch "$backup/complete" || return 1
}

mark_asset_change() {
  [[ -f "$1/complete" && -f "$1/${2##*/}.state" ]] || return 1
  touch "$1/${2##*/}.changed" || return 1
}

restore_asset_group() {
  local backup=$1 target name state failed=0
  shift
  [[ -f "$backup/complete" ]] || return 1
  for target in "$@"; do
    name=${target##*/}
    [[ -f "$backup/$name.changed" ]] || continue
    state=$(cat "$backup/$name.state") || { failed=1; continue; }
    case "$state" in
      present) restore_file_backup "$backup/$name" "$target" || { failed=1; continue; } ;;
      absent) rm -f -- "$target" || { failed=1; continue; } ;;
      *) failed=1; continue ;;
    esac
    rm -f -- "$backup/$name.changed" || failed=1
  done
  return "$failed"
}

assert_no_pending_recovery() {
  local pending
  assert_admin_path "$RECOVERY_ROOT"
  if [[ -e "$RECOVERY_ROOT" ]]; then
    [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]] || fail "Unsafe installer recovery directory."
    pending=$(find -P "$RECOVERY_ROOT" -mindepth 1 -maxdepth 1 -print -quit) || fail "Cannot inspect installer recovery directory."
    [[ -z "$pending" ]] ||
      fail "Incomplete installer recovery exists in $RECOVERY_ROOT; recover it from an administrator terminal before installing."
  fi
}

preserve_failed_recovery() {
  [[ "$RECOVERY_FAILED" == 1 && "$RECOVERY_RETAINED" == 0 ]] || return 0
  # An EXIT handler must not exit early on unsafe parents or failed storage.
  # Keep the original private temporary tree if durable retention fails.
  local destination
  chmod 0700 -- "$TEMP_DIR" || { log "ERROR: Cannot secure recovery temporary directory $TEMP_DIR; administrator intervention is required."; return 1; }
  if (assert_admin_path "$RECOVERY_ROOT") && [[ ! -L "$RECOVERY_ROOT" ]] &&
     install -d -m 0700 -- "$TEMP_DIR/recovery" &&
     install -d -m 0700 -o root -g root "$RECOVERY_ROOT" &&
     destination=$(mktemp -d "$RECOVERY_ROOT/failed.XXXXXX"); then
    if printf 'schemaVersion=1\nservice=%s\npreviousRelease=%s\npreviousRuntime=%s\noriginalRoot=%s\ncliPreviousTarget=%s\ncliCreated=%s\nlegacyService=%s\nlegacyWasActive=%s\nlegacyWasEnabled=%s\n' \
      "$SERVICE_NAME" "${PREVIOUS_RELEASE:-}" "${PREVIOUS_RUNTIME:-}" "${APP_ORIGINAL_ROOT:-}" "${CLI_PREVIOUS_TARGET:-}" "${CLI_LINK_CREATED:-0}" \
      "${LEGACY_SERVICE_NAME:-}" "${LEGACY_WAS_ACTIVE:-0}" "${LEGACY_WAS_ENABLED:-0}" > "$TEMP_DIR/recovery/context" &&
       chmod 0600 -- "$TEMP_DIR/recovery/context" &&
       mv -T -- "$TEMP_DIR/recovery" "$destination/snapshots"; then
      RECOVERY_RETAINED=1
      log "ERROR: Recovery is incomplete; private snapshots were retained in $destination. Service restart was withheld."
      return 0
    fi
    rmdir -- "$destination" || true
  fi
  log "ERROR: Recovery is incomplete; preserve $TEMP_DIR for administrator recovery."
  return 1
}
