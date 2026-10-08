#!/usr/bin/env bash
# Shared by the managed installer/uninstaller. Only these fixed roots are used.
layout_roots() {
  printf '%s\n' "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"
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
