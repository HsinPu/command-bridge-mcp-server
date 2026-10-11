#!/usr/bin/env bash
# Real private files/links and production validators; never change host services.
set -Eeuo pipefail
work=$(mktemp -d /tmp/cb-service-layout.XXXXXX)
rewrite() {
  sed -e "s|/usr/local/lib/command-bridge|$work/app|g" \
      -e "s|/usr/local/bin/command-bridge|$work/bin/command-bridge|g" \
      -e "s|/opt/command-bridge|$work/old/command-bridge|g" \
      -e "s|/etc/systemd/system/|$work/units/|g" \
      -e "s|/etc/command-bridge|$work/config|g" \
      -e "s|/var/lib/command-bridge|$work/data/command-bridge|g" "$1"
}
rewrite scripts/linux-systemd/install.sh > "$work/install.sh"
rewrite scripts/linux-systemd/recovery.sh > "$work/recovery.sh"
rewrite scripts/linux-systemd/layout.sh > "$work/layout.sh"
source "$work/install.sh"
source "$work/layout.sh"
source <(sed -n '/^inspect_installed_unit()/,/^}/p' scripts/linux-systemd/uninstall.sh)
trap - EXIT ERR
trap 'rm -rf --one-file-system -- "$work"' EXIT
mkdir -p "$work/units" "$work/bin" "$CONFIG_DIR" "$work/data"
printf 'private-preserved-token\n' > "$CONFIG_FILE"
printf 'preserved-work-and-audit\n' > "$work/data/preserved"
before=$(sha256sum "$CONFIG_FILE" "$work/data/preserved")
stat() {
  if [[ "$2" == %u ]]; then [[ "$3" != "${BAD_OWNER_PATH:-}" ]] && echo 0 || echo 1234;
  elif [[ "$2" == %a && "$3" == /tmp ]]; then echo 755;
  else command stat "$@"; fi
}
find() {
  local -a args=()
  while (($#)); do
    if [[ "$1" == -uid && "$2" == 0 ]]; then args+=(-uid "$(id -u)"); shift 2;
    else args+=("$1"); shift; fi
  done
  command find "${args[@]}"
}
systemctl() {
  if [[ "$*" == *'--property=FragmentPath --value'* ]]; then
    [[ ! -f "$UNIT_FILE" ]] || printf '%s\n' "${MOCK_FRAGMENT:-$UNIT_FILE}"
  elif [[ "$1" == show ]]; then
    [[ "${MOCK_SHOW_FAILURE:-0}" == 0 ]] || return 7
    printf '%s\n' "${MOCK_STATE:-LoadState=not-found}" "${MOCK_ACTIVE:-ActiveState=inactive}" "${MOCK_FRAGMENT_STATE:-FragmentPath=}"
  fi
}
expect_failure() { if ( "$@" ) > "$work/failure" 2>&1; then echo 'Service layout unexpectedly accepted an unsafe case.' >&2; exit 1; fi; }
SOURCE_REF=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BUILT_PACKAGE_VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
release="$RELEASES_DIR/v$BUILT_PACKAGE_VERSION-$SOURCE_REF"
runtime="$RUNTIME_DIR/node-v$NODE_VERSION-linux-x64"
make_cache() {
  mkdir -p "$release/dist" "$runtime/bin"
  printf '%s\n' "$SOURCE_REF" > "$release/.command-bridge-release"
  printf '{"version":"%s","sourceSha":"%s","runtimeVersion":"%s"}\n' "$BUILT_PACKAGE_VERSION" "$SOURCE_REF" "$NODE_VERSION" > "$release/install-info.json"
  printf 'fixture-source\n' > "$release/dist/index.js"
  printf '#!/bin/sh\nprintf "v%s\\n"\n' "$NODE_VERSION" > "$runtime/bin/node"
  chmod 0755 "$runtime/bin/node"
}
make_cache
for prefix in '' '/usr/bin/env -- '; do
  for root in "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"; do
    printf 'ExecStart=%s%s/runtime/current/bin/node %s/current/dist/index.js\nUser=command-bridge\n' "$prefix" "$root" "$root" > "$UNIT_FILE"
    is_managed_service_entry "$UNIT_FILE" "$root"
    inspect_installed_unit
    EXISTING_APP_ROOT=$root
    assert_new_installation_paths
    # A same-owner installer-account service is recognized in either format.
    printf 'ExecStart=%s%s/runtime/current/bin/node %s/current/dist/index.js\nUser=10001\nEnvironment=XDG_DATA_HOME=%s\n' "$prefix" "$root" "$root" "$INSTALLER_STATE_DIR" > "$UNIT_FILE"
    RUN_AS_INSTALLER=1 INSTALLER_UID=10001
    assert_new_installation_paths
    INSTALLER_UID=10002; expect_failure assert_new_installation_paths
    INSTALLER_UID=10001; RUN_AS_INSTALLER=0; expect_failure assert_new_installation_paths
  done
done
EXISTING_APP_ROOT=$INSTALL_ROOT
for entry in '/bin/sh -c arbitrary' "/usr/bin/env -i $RUNTIME_LINK/bin/node $CURRENT_LINK/dist/index.js" "/usr/bin/env -- $RUNTIME_LINK/bin/node $CURRENT_LINK/dist/index.js extra" "/usr/bin/env KEY=value $RUNTIME_LINK/bin/node $CURRENT_LINK/dist/index.js"; do
  printf 'ExecStart=%s\nUser=command-bridge\n' "$entry" > "$UNIT_FILE"
  expect_failure assert_new_installation_paths
  expect_failure inspect_installed_unit
done
printf 'ExecStart=%s/bin/node %s/dist/index.js\nExecStart=/bin/false\nUser=command-bridge\n' "$RUNTIME_LINK" "$CURRENT_LINK" > "$UNIT_FILE"
expect_failure assert_new_installation_paths; expect_failure inspect_installed_unit
rm "$UNIT_FILE"
UPDATE_ONLY=0
inspect_application_layout; [[ -z "$EXISTING_APP_ROOT" ]]
[[ "$(sha256sum "$CONFIG_FILE" "$work/data/preserved")" == "$before" ]]
UPDATE_ONLY=1; expect_failure inspect_application_layout; UPDATE_ONLY=0
for unit in "$UNIT_FILE" "$LEGACY_UNIT_FILE" "$work/units/command-bridge-update.service"; do
  touch "$unit"; expect_failure inspect_application_layout; rm "$unit"
done
for state in loaded masked error unexpected; do
  MOCK_STATE="LoadState=$state"; expect_failure inspect_application_layout
done
MOCK_STATE=; MOCK_SHOW_FAILURE=1; expect_failure inspect_application_layout; MOCK_SHOW_FAILURE=0
for state in active activating deactivating unexpected; do
  MOCK_ACTIVE="ActiveState=$state"; expect_failure inspect_application_layout
done
MOCK_ACTIVE=ActiveState=failed; inspect_application_layout; MOCK_ACTIVE=
MOCK_STATE=$'LoadState=not-found\nLoadState=not-found'; expect_failure inspect_application_layout; MOCK_STATE=
MOCK_FRAGMENT_STATE=FragmentPath=/unexpected; expect_failure inspect_application_layout; MOCK_FRAGMENT_STATE=
for pointer in "$CURRENT_LINK" "$RUNTIME_LINK"; do
  ln -s "$work/missing" "$pointer"; expect_failure inspect_application_layout; rm "$pointer"
  mkdir "$pointer"; expect_failure inspect_application_layout; rmdir "$pointer"
done
BAD_OWNER_PATH=$INSTALL_ROOT; expect_failure inspect_application_layout; BAD_OWNER_PATH=
chmod 0777 "$runtime/bin/node"; expect_failure inspect_application_layout; chmod 0755 "$runtime/bin/node"
findmnt() { printf '%s\n' "$INSTALL_ROOT/runtime"; }; expect_failure inspect_application_layout; unset -f findmnt
mkdir -p "$PREVIOUS_INSTALL_ROOT"; mv "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT/cache"
# Move the private cache to an old root: it must not be guessed into a migration.
mv "$PREVIOUS_INSTALL_ROOT/cache/"* "$PREVIOUS_INSTALL_ROOT/"; rmdir "$PREVIOUS_INSTALL_ROOT/cache"
expect_failure inspect_application_layout
mv "$PREVIOUS_INSTALL_ROOT" "$INSTALL_ROOT"
inspect_application_layout

# Exercise cache validation and the actual first-install activation rollback.
TEMP_DIR="$work/temporary"; mkdir -p "$TEMP_DIR/node-runtime/bin"
ln -s "$TEST_NODE" "$TEMP_DIR/node-runtime/bin/node"
restore_selinux_path() { :; }; restore_current_selinux_layout() { :; }
install() { local -a args=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; command install "${args[@]}"; }
chown() { :; }
printf '%s\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > "$release/.command-bridge-release"
expect_failure install_runtime_and_release x64
printf '%s\n' "$SOURCE_REF" > "$release/.command-bridge-release"
cp "$release/install-info.json" "$work/info.json"
printf '{}\n' > "$release/install-info.json"; expect_failure install_runtime_and_release x64
cp "$work/info.json" "$release/install-info.json"
mv "$release/dist/index.js" "$work/index.js"; expect_failure install_runtime_and_release x64; mv "$work/index.js" "$release/dist/index.js"
install_runtime_and_release x64
[[ "$(readlink "$CURRENT_LINK")" == "$release" && "$(readlink "$RUNTIME_LINK")" == "$runtime" ]]
rollback_application_layout() { :; }; restore_diagnostic_assets() { :; }; restore_managed_update_assets() { :; }
UNIT_CHANGED=1
rollback_activation
[[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" && ! -e "$RUNTIME_LINK" && ! -L "$RUNTIME_LINK" ]]
[[ -f "$release/install-info.json" && -x "$runtime/bin/node" ]]
inspect_application_layout; [[ -z "$EXISTING_APP_ROOT" ]]
install_runtime_and_release x64
inspect_application_layout; [[ "$EXISTING_APP_ROOT" == "$INSTALL_ROOT" ]]
[[ "$(sha256sum "$CONFIG_FILE" "$work/data/preserved")" == "$before" ]]
printf 'Managed service entry, inactive retry and preservation checks passed.\n'
