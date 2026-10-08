#!/usr/bin/env bash
set -Eeuo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
sed -e "s|/usr/local/bin/command-bridge|$work/bin/command-bridge|g" -e "s|/var/lib/command-bridge|$work/state|g" -e "s|/usr/local/lib/command-bridge|$work/app|g" -e "s|/opt/command-bridge|$work/old|g" -e "s|/etc/command-bridge|$work/config|g" \
  -e "s|/etc/systemd/system/|$work/units/|g" scripts/linux-systemd/install.sh > "$work/installer.sh"
cp scripts/linux-systemd/recovery.sh "$work/recovery.sh"
source "$work/installer.sh"
source scripts/linux-systemd/layout.sh
source scripts/linux-systemd/program-migration.sh
trap - EXIT ERR
assert_admin_path() { [[ ! -L "$1" ]]; }
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$CURRENT_LINK/dist" "$RUNTIME_LINK/bin" "$CONFIG_DIR" "$work/units" "$work/home" "$work/temp"
ln -s "$TEST_NODE" "$RUNTIME_LINK/bin/node"
cp dist/updateState.js "$CURRENT_LINK/dist/updateState.js"
printf '{"type":"module"}\n' > "$CURRENT_LINK/package.json"
ln -s "$(pwd)/node_modules" "$CURRENT_LINK/node_modules"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '{"sourceSha":"%s"}\n' "$sha" > "$CURRENT_LINK/install-info.json"
printf '{}\n' > "$CONFIG_DIR/policy.json"
TEMP_DIR="$work/temp"
install() { local -a args=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; command install "${args[@]}"; }
chown() { :; }
getent() { printf 'alice:x:10001:10002::%s:/bin/bash\n' "$work/home"; }
SUDO_USER=alice; SUDO_UID=10001
unit() { printf 'ExecStart=%s/bin/node %s/dist/index.js\nUser=%s\nEnvironment=XDG_DATA_HOME=%s\n' "$RUNTIME_LINK" "$CURRENT_LINK" "$1" "$INSTALLER_STATE_DIR" > "$UNIT_FILE"; }
expect_failure() { if ( "$@" ); then echo 'Expected failure' >&2; exit 1; fi; }
UPDATE_ONLY=1; EXPECTED_INSTALLED_SHA="$sha"
for mode in allowlist guarded unrestricted; do
  printf '# preserve all fields and quoting\nexport COMMAND_BRIDGE_EXECUTION_MODE="%s" # mode\nCOMMAND_BRIDGE_BEARER_TOKEN=fixture-only\n' "$mode" > "$CONFIG_FILE"
  cp "$CONFIG_FILE" "$work/before"
  unit 10001
  RUN_AS_INSTALLER=0
  prepare_update
  [[ "$PRESERVED_EXECUTION_MODE" == "$mode" && "$RUN_AS_INSTALLER" == 1 ]]
  select_service_identity
  assert_new_installation_paths
  install_configuration
  cmp "$CONFIG_FILE" "$work/before"
done
unit command-bridge; RUN_AS_INSTALLER=0
prepare_update; [[ "$RUN_AS_INSTALLER" == 0 ]]; select_service_identity; assert_new_installation_paths
EXPECTED_INSTALLED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
expect_failure prepare_update
EXPECTED_INSTALLED_SHA="$sha"; unit 99999
prepare_update; select_service_identity
expect_failure assert_new_installation_paths
unit command-bridge
printf 'COMMAND_BRIDGE_EXECUTION_MODE=invalid\n' > "$CONFIG_FILE"
expect_failure prepare_update
expect_failure parse_arguments --update --expected-installed-sha "$sha" --guarded
# A legacy worker retains its /opt installation path in memory. Reject before
# deployment changes; terminal migration is allowed when that worker is idle.
EXISTING_APP_ROOT="$PREVIOUS_INSTALL_ROOT"
systemctl() { printf '%s\n' "${WORKER_STATE:-inactive}"; }
for state in active activating deactivating unexpected; do
  WORKER_STATE=$state; expect_failure assert_application_migration_driver
done
for state in inactive failed; do WORKER_STATE=$state; assert_application_migration_driver; done
systemctl() { return 9; }; expect_failure assert_application_migration_driver
EXISTING_APP_ROOT="$INSTALL_ROOT"; assert_application_migration_driver
EXISTING_APP_ROOT=; assert_application_migration_driver
printf 'Linux update preservation and stale/account checks passed.\n'
