#!/usr/bin/env bash
# Shared by the managed installer/uninstaller. Only these fixed roots are used.
layout_roots() {
  printf '%s\n' "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"
}

# Accept only the two managed entries, never extra argv, env settings or Shells.
is_managed_service_entry() {
  local unit=$1 root=$2 count
  count=$(grep -c '^ExecStart=' "$unit") || return 1
  [[ "$count" == 1 ]] || return 1
  grep -Fxq "ExecStart=/usr/bin/env -- $root/runtime/current/bin/node $root/current/dist/index.js" "$unit" ||
    grep -Fxq "ExecStart=$root/runtime/current/bin/node $root/current/dist/index.js" "$unit"
}

assert_inactive_program_cache() {
  local root=$1 unit state line load_count active_count fragment_count
  [[ "$root" == "$INSTALL_ROOT" && "${UPDATE_ONLY:-0}" == 0 &&
     ! -e "$root/current" && ! -L "$root/current" &&
     ! -e "$root/runtime/current" && ! -L "$root/runtime/current" ]] ||
    fail "Incomplete active deployment; the service was not changed."
  for unit in "${UNIT_FILE:-/etc/systemd/system/command-bridge.service}" \
      "${LEGACY_UNIT_FILE:-/etc/systemd/system/command-bridge-mcp-server.service}" \
      "${UPDATE_UNIT_FILE:-/etc/systemd/system/command-bridge-update.service}"; do
    [[ ! -e "$unit" && ! -L "$unit" ]] || fail "Incomplete deployment still has a service unit; restore it or use ordinary uninstall before reinstalling."
    state=$(systemctl show "${unit##*/}" --property=LoadState --property=ActiveState --property=FragmentPath) ||
      fail "Cannot verify inactive deployment services; no deployment was changed."
    load_count=0; active_count=0; fragment_count=0
    while IFS= read -r line; do
      case "$line" in
        LoadState=not-found) load_count=$((load_count + 1)) ;;
        ActiveState=inactive|ActiveState=failed) active_count=$((active_count + 1)) ;;
        FragmentPath=) fragment_count=$((fragment_count + 1)) ;;
        *) fail "Incomplete deployment has a registered or active service; no deployment was changed." ;;
      esac
    done <<< "$state"
    [[ "$load_count" == 1 && "$active_count" == 1 && "$fragment_count" == 1 ]] ||
      fail "Incomplete deployment has a registered or active service; no deployment was changed."
  done
}

validate_installer_recovery() {
  local root=/var/lib/command-bridge-recovery item unsafe
  assert_admin_path "$root"
  [[ -e "$root" || -L "$root" ]] || return 0
  [[ -d "$root" && ! -L "$root" ]] || fail "Unsafe installer recovery directory."
  assert_no_program_mounts "$root"
  unsafe=$(find -P "$root" -xdev \( -type l -o ! -uid 0 -o -perm /022 \) -print -quit) || fail "Cannot inspect installer recovery contents."
  [[ -z "$unsafe" ]] || fail "Unsafe installer recovery contents; no files were removed."
  for item in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -e "$item" ]] || continue
    [[ "$item" == "$root/failed."* && -d "$item/snapshots" && -f "$item/snapshots/context" ]] || fail "Unrecognized installer recovery contents; no files were removed."
    grep -Fxq 'schemaVersion=1' "$item/snapshots/context" || fail "Unrecognized installer recovery metadata."
  done
}

assert_admin_path() {
  local path=$1 mode
  while [[ "$path" != / ]]; do
    if [[ -e "$path" || -L "$path" ]]; then
      [[ ! -L "$path" && "$(stat -c %u "$path")" == 0 ]] || fail "Unsafe deployment path: $path"
      mode=$(stat -c %a "$path")
      (( (8#$mode & 022) == 0 )) || fail "Deployment path is writable by non-administrators: $path"
    fi
    path=${path%/*}; [[ -n "$path" ]] || path=/
  done
}

assert_no_program_mounts() {
  local root=$1 target mounts
  mounts=$(findmnt -rn -o TARGET) || fail "Cannot inspect deployment mount points."
  while IFS= read -r target; do
    [[ "$target" != "$root" && "$target" != "$root/"* ]] || fail "Refusing a mounted deployment path: $target"
  done <<< "$mounts"
}

assert_managed_program_tree() {
  local root=$1 marker name sha found=0 unsafe
  [[ -d "$root" && ! -L "$root" ]] || fail "Deployment is not a regular directory: $root"
  assert_admin_path "$root"
  assert_no_program_mounts "$root"
  unsafe=$(find -P "$root" -xdev \( ! -uid 0 -o \( ! -type l -a -perm /022 \) \) -print -quit) || fail "Cannot inspect deployment ownership."
  [[ -z "$unsafe" ]] || fail "Deployment contains files writable by non-administrators: $root"
  # Recognize installed releases without executing a binary or configuration.
  for marker in "$root"/releases/v*/.command-bridge-release; do
    [[ -f "$marker" && ! -L "$marker" && ! -L "${marker%/*}" && ! -L "$root/releases" ]] || continue
    name=${marker%/*}; name=${name##*/}; sha=$(cat "$marker")
    if [[ "$sha" =~ ^[a-f0-9]{40}$ && "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-${sha}$ ]]; then found=1; fi
  done
  [[ "$found" == 1 ]] || fail "No managed release identity at $root; no files were removed."
}

assert_layout_alias() {
  local path=$1 target resolved
  [[ -L "$path" ]] || return 0
  # Resolving the alias alone skips the original parent (for example /opt).
  # Protect the directory entry as well as its target before any host changes.
  assert_admin_path "${path%/*}"
  [[ "$(stat -c %u "$path")" == 0 ]] || fail "Non-administrator deployment alias: $path"
  target=$(readlink "$path")
  [[ "$path" != "$INSTALL_ROOT" && ( "$target" == "$INSTALL_ROOT" || ( "$path" == "$LEGACY_INSTALL_ROOT" && "$target" == "$PREVIOUS_INSTALL_ROOT" ) ) ]] || fail "Unexpected deployment alias: $path"
  resolved=$(readlink -m "$path")
  [[ "$resolved" == "$INSTALL_ROOT" || "$resolved" == "$PREVIOUS_INSTALL_ROOT" ]] || fail "Deployment alias escaped the managed roots."
}

inspect_program_roots() {
  local root
  PROGRAM_ROOTS=()
  while IFS= read -r root; do
    if [[ -L "$root" ]]; then
      assert_layout_alias "$root"
    elif [[ -e "$root" ]]; then
      assert_managed_program_tree "$root"
      PROGRAM_ROOTS+=("$root")
    fi
    if [[ -e "$root.migration-backup" || -L "$root.migration-backup" ]]; then
      fail "An interrupted migration backup exists at $root.migration-backup; recover it before installing."
    fi
  done < <(layout_roots)
}

inspect_application_layout() {
  inspect_program_roots
  (( ${#PROGRAM_ROOTS[@]} <= 1 )) || fail "Multiple independent CommandBridge deployments exist; the services were not changed."
  EXISTING_APP_ROOT=${PROGRAM_ROOTS[0]:-}
  if [[ -n "$EXISTING_APP_ROOT" ]]; then
    if [[ ! -e "$EXISTING_APP_ROOT/current" && ! -L "$EXISTING_APP_ROOT/current" &&
          ! -e "$EXISTING_APP_ROOT/runtime/current" && ! -L "$EXISTING_APP_ROOT/runtime/current" ]]; then
      # Failed first activation removes both pointers but retains verified files.
      # Reuse them only at the current root with no registered service; never
      # infer an old active release or repair a damaged running deployment.
      assert_inactive_program_cache "$EXISTING_APP_ROOT"
      EXISTING_APP_ROOT=''
      log "Reusing protected program files from an inactive installation; the selected verified source will be built and validated."
      return
    fi
    local release runtime
    release=$(readlink -f "$EXISTING_APP_ROOT/current") || fail "Missing active release."
    runtime=$(readlink -f "$EXISTING_APP_ROOT/runtime/current") || fail "Missing active runtime."
    [[ -L "$EXISTING_APP_ROOT/current" && "$release" == "$EXISTING_APP_ROOT/releases/"* &&
       -L "$EXISTING_APP_ROOT/runtime/current" && "$runtime" == "$EXISTING_APP_ROOT/runtime/"* &&
       -f "$release/install-info.json" && -x "$runtime/bin/node" ]] || fail "Incomplete active deployment; the service was not changed."
  fi
}

check_deployment_space() {
  local parent=$INSTALL_ROOT available required=400000 copied=0
  while [[ ! -d "$parent" ]]; do parent=${parent%/*}; done
  if [[ -n "${EXISTING_APP_ROOT:-}" && "$EXISTING_APP_ROOT" != "$INSTALL_ROOT" ]]; then
    copied=$(du -sk -- "$EXISTING_APP_ROOT" | awk '{print $1}')
    [[ "$copied" =~ ^[0-9]+$ ]] || fail "Cannot estimate migration space."
    required=$((required + copied))
  fi
  available=$(df -Pk "$parent" | awk 'NR == 2 {print $4}')
  [[ "$available" =~ ^[0-9]+$ ]] || fail "Cannot inspect destination free space."
  (( available >= required )) || fail "Insufficient free space for deployment and migration under $parent (need ${required} KiB)."
}
