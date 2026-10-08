#!/usr/bin/env bash
# All paths and mutations are confined to a disposable directory, also as non-root.
set -Eeuo pipefail
work=$(mktemp -d /tmp/cb-recovery-test.XXXXXX)
trap 'rm -rf --one-file-system -- "$work"' EXIT
export FIXTURE=$work
rewrite() {
  sed -e "s|/usr/local/lib/command-bridge|$work/app|g" \
      -e "s|/usr/local/libexec|$work/libexec|g" -e "s|/usr/local/bin|$work/bin|g" \
      -e "s|/etc/command-bridge|$work/config|g" -e "s|/etc/systemd/system|$work/units|g" \
      -e "s|/etc/sudoers.d|$work/sudoers|g" -e "s|/var/lib/command-bridge|$work/data/command-bridge|g" \
      -e "s|/var/empty/command-bridge|$work/empty|g" -e "s|/run/command-bridge-mcp-server|$work/locks|g" \
      -e "s|/opt/command-bridge|$work/old|g" "$1"
}
for module in install recovery managed-update diagnostics layout uninstall; do rewrite "scripts/linux-systemd/$module.sh" > "$work/$module.sh"; done
sed -i '/^main "\$@"$/d' "$work/uninstall.sh"
# Model root ownership under the build account only in the copied validator.
sed -i "s/! -uid 0/! -uid $(id -u)/g" "$work/layout.sh"
cat > "$work/common.sh" <<'SH'
source "$FIXTURE/install.sh"
source "$FIXTURE/managed-update.sh"
source "$FIXTURE/diagnostics.sh"
TEMP_DIR="$FIXTURE/temporary"
RUN_AS_INSTALLER=1; INSTALLER_UID=777
install() {
  local -a args=()
  while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
  command install "${args[@]}"
}
stat() { if [[ "$1" == -c && "$2" == %u ]]; then echo 0; else command stat "$@"; fi; }
require_command() { :; }
visudo() { return 0; }
restore_selinux_path() { [[ "${BAD_LABEL:-0}" == 0 ]]; }
restore_current_selinux_layout() { [[ "${BAD_LABEL:-0}" == 0 ]]; }
rollback_application_layout() { return 0; }
systemctl() { printf '%s\n' "$*" >> "$FIXTURE/service-events"; if [[ "$1" == show ]]; then printf 'loaded\n'; fi; [[ "${BAD_RELOAD:-0}" == 0 || "$1" != daemon-reload ]] && [[ "${BAD_STOP:-0}" == 0 || "$1" != stop ]]; }
chown() { :; }
SH
prepare() {
  rm -rf -- "$work/libexec" "$work/units" "$work/sudoers" "$work/temporary" "$work/config" "$work/data"
  mkdir -p "$work/libexec/command-bridge-update" "$work/libexec/command-bridge-diagnostics" "$work/units" "$work/sudoers" "$work/config"
  : > "$work/service-events"
  for target in libexec/command-bridge-update/request libexec/command-bridge-update/state.mjs units/command-bridge-update.service sudoers/command-bridge-update libexec/command-bridge-diagnostics/reader libexec/command-bridge-diagnostics/reader.mjs sudoers/command-bridge-diagnostics; do
    printf 'original:%s\n' "$target" > "$work/$target"
    chmod 0644 "$work/$target"
  done
  printf 'COMMAND_BRIDGE_EXECUTION_MODE=unrestricted\nCOMMAND_BRIDGE_BEARER_TOKEN=fixture-preserved-token\n' > "$work/config/command-bridge.env"
  cp "$work/config/command-bridge.env" "$work/expected.env"
  mkdir -p "$work/temporary/source/packaging/linux" "$work/temporary/source/scripts/diagnostics" "$work/temporary/source/scripts/managed-update" "$work/temporary/source/packaging/systemd" "$work/temporary/source/packaging"
  for target in packaging/linux/diagnostic-reader scripts/diagnostics/read-linux.mjs packaging/linux/update-request scripts/managed-update/state.mjs packaging/systemd/command-bridge-update.service packaging/policy.example.json; do
    printf 'candidate\n' > "$work/temporary/source/$target"
  done
  printf '{}\n' > "$work/config/policy.json"
}
check_original_assets() {
  local target
  for target in libexec/command-bridge-update/request libexec/command-bridge-update/state.mjs units/command-bridge-update.service sudoers/command-bridge-update libexec/command-bridge-diagnostics/reader libexec/command-bridge-diagnostics/reader.mjs sudoers/command-bridge-diagnostics; do
    grep -Fxq "original:$target" "$work/$target"
  done
}
case "${1:-}" in
  backup)
    for helper in update diagnostic; do
      count=3; [[ "$helper" != update ]] || count=4
      for ((position=1;position<=count;position++)); do
        prepare
        if HELPER=$helper POSITION=$position bash -c '
          source "$FIXTURE/common.sh"
          copies=0
          cp() { ((copies+=1)); if [[ "$copies" == "$POSITION" ]]; then printf partial > "${@: -1}"; return 93; fi; command cp "$@"; }
          if [[ "$HELPER" == update ]]; then install_managed_update; else install_diagnostic_assets; fi
        ' > "$work/output" 2>&1; then echo 'Partial backup was accepted'; exit 1; fi
        check_original_assets
        ! grep -q '^restart ' "$work/service-events"
      done
      for ((position=1;position<=count;position++)); do
        prepare
        if HELPER=$helper POSITION=$position bash -c '
          source "$FIXTURE/common.sh"
          if [[ "$HELPER" == update ]]; then targets=("$FIXTURE/libexec/command-bridge-update/request" "$FIXTURE/libexec/command-bridge-update/state.mjs" "$FIXTURE/units/command-bridge-update.service" "$FIXTURE/sudoers/command-bridge-update")
          else targets=("$FIXTURE/libexec/command-bridge-diagnostics/reader" "$FIXTURE/libexec/command-bridge-diagnostics/reader.mjs" "$FIXTURE/sudoers/command-bridge-diagnostics"); fi
          chmod 0666 "${targets[POSITION-1]}"
          if [[ "$HELPER" == update ]]; then install_managed_update; else install_diagnostic_assets; fi
        ' > "$work/output" 2>&1; then echo 'Unsafe asset accepted'; exit 1; fi
        check_original_assets
      done
    done
    ;;
  configuration)
    prepare
    if bash -c '
      source "$FIXTURE/common.sh"
      cp() { printf partial > "${@: -1}"; return 93; }
      install_configuration
    ' > "$work/output" 2>&1; then echo 'Incomplete configuration backup accepted'; exit 1; fi
    cmp -s "$work/config/command-bridge.env" "$work/expected.env"
    prepare
    if bash -c '
      source "$FIXTURE/common.sh"
      install_configuration
      printf corrupt >> "$CONFIG_BACKUP"
      exit 38
    ' > "$work/output" 2>&1; then exit 1; else [[ "$?" == 38 ]]; fi
    # Corrupted snapshots must not be copied back over the candidate either.
    grep -Fxq COMMAND_BRIDGE_EXECUTION_MODE=allowlist "$work/config/command-bridge.env"
    ! grep -q corrupt "$work/config/command-bridge.env"
    prepare
    if bash -c '
      source "$FIXTURE/common.sh"
      install_configuration
      [[ "$CONFIG_CHANGED" == 1 ]]
      exit 37
    ' > "$work/output" 2>&1; then exit 1; else [[ "$?" == 37 ]]; fi
    cmp -s "$work/config/command-bridge.env" "$work/expected.env"
    ;;
  restore)
    prepare
    bash -c '
      source "$FIXTURE/common.sh"; trap - EXIT ERR
      LEGACY_MIGRATION=1; LEGACY_WAS_ACTIVE=1; LEGACY_WAS_ENABLED=1
      restore_selinux_layout() { return 0; }
      systemctl() { printf "%s\n" "$*" >> "$FIXTURE/service-events"; [[ "$1" != disable ]]; }
      rollback_activation || { echo "Absent candidate blocked early legacy rollback"; exit 1; }
      [[ "$RECOVERY_FAILED" == 0 ]]
      grep -Fxq "restart $LEGACY_SERVICE_NAME.service" "$FIXTURE/service-events"
      ! grep -q "^disable " "$FIXTURE/service-events"
    '
    prepare
    bash -c '
      source "$FIXTURE/common.sh"; trap - EXIT ERR
      install_configuration
      PREVIOUS_RELEASE="$FIXTURE/old-release"; BAD_STOP=1
      rollback_application_layout() { echo unexpected-layout-change >> "$FIXTURE/service-events"; }
      if rollback_activation; then echo "Failed stop returned success"; exit 1; fi
      [[ "$RECOVERY_FAILED" == 1 && -f "$CONFIG_BACKUP" && "$CONFIG_CHANGED" == 1 ]]
      grep -Fxq COMMAND_BRIDGE_EXECUTION_MODE=allowlist "$CONFIG_FILE"
      ! grep -q "unexpected-layout-change\|^restart " "$FIXTURE/service-events"
    '
    for helper in update diagnostic; do
    for fault in copy remove label reload; do
      prepare
      FAULT=$fault HELPER=$helper bash -c '
        source "$FIXTURE/common.sh"; trap - EXIT ERR
        if [[ "$FAULT" == remove ]]; then
          if [[ "$HELPER" == update ]]; then rm "$FIXTURE/libexec/command-bridge-update/state.mjs"; else rm "$FIXTURE/libexec/command-bridge-diagnostics/reader.mjs"; fi
        fi
        if [[ "$HELPER" == update ]]; then install_managed_update; backup=$MANAGED_UPDATE_BACKUP
        else install_diagnostic_assets; backup=$DIAGNOSTIC_BACKUP; fi
        case "$FAULT" in
          copy) cp() { return 91; } ;;
          remove) rm() { return 92; } ;;
          label) BAD_LABEL=1 ;;
          reload) BAD_RELOAD=1 ;;
        esac
        if [[ "$HELPER" == update ]]; then
          if restore_managed_update_assets; then echo "Failed restore returned success"; exit 1; fi
          [[ "$MANAGED_UPDATE_BACKUP" == "$backup" ]]
        else
          if [[ "$FAULT" != reload ]] && restore_diagnostic_assets; then echo "Failed restore returned success"; exit 1; fi
          [[ "$DIAGNOSTIC_BACKUP" == "$backup" ]]
        fi
        [[ -f "$backup/complete" ]]
        PREVIOUS_RELEASE="$FIXTURE/old-release"; mkdir -p "$PREVIOUS_RELEASE"
        mkdir -p "$INSTALL_ROOT"
        : > "$FIXTURE/service-events"
        if rollback_activation; then echo "Failed rollback returned success"; exit 1; fi
        [[ "$RECOVERY_FAILED" == 1 ]]
        ! grep -q "^restart " "$FIXTURE/service-events"
      '
    done
    done
    prepare
    bash -c '
      source "$FIXTURE/common.sh"; trap - EXIT ERR
      rm -rf "$FIXTURE/libexec/command-bridge-diagnostics"; rm "$FIXTURE/sudoers/command-bridge-diagnostics"
      install_diagnostic_assets
      restore_diagnostic_assets || exit 1
      [[ ! -e "$FIXTURE/libexec/command-bridge-diagnostics" && ! -e "$FIXTURE/sudoers/command-bridge-diagnostics" ]]
    '
    ;;
  retain)
    prepare
    if bash -c '
      source "$FIXTURE/common.sh"
      # Durable directory checks are mocked only inside this private fixture.
      assert_admin_path() { [[ "$1" == "$RECOVERY_ROOT" ]]; }
      new_temp=$(mktemp -d /tmp/command-bridge-install.XXXXXX)
      rmdir "$new_temp"; mv "$TEMP_DIR" "$new_temp"; TEMP_DIR=$new_temp
      printf '%s\n' "$TEMP_DIR" > "$FIXTURE/retention-temp"
      install_configuration
      cp() { return 91; }
      mkdir -p "$TEMP_DIR/source/build-output"
      exit 41
    ' > "$work/output" 2>&1; then exit 1; else [[ "$?" == 41 ]]; fi
    ! grep -q 'fixture-preserved-token' "$work/output"
    retained=$(find "$work/data/command-bridge-recovery" -name previous-config.env -print)
    [[ -n "$retained" && -f "$retained.info" ]]
    cmp -s "$retained" "$work/expected.env"
    [[ ! -e "$(cat "$work/retention-temp")" ]]
    [[ "$(command stat -c %a "$work/data/command-bridge-recovery")" == 700 ]]
    if bash -c 'source "$FIXTURE/common.sh"; trap - EXIT ERR; assert_admin_path() { :; }; assert_no_pending_recovery' > "$work/output" 2>&1; then echo 'Pending recovery ignored'; exit 1; fi
    prepare
    bash -c '
      source "$FIXTURE/common.sh"; trap - EXIT ERR
      install_configuration
      RECOVERY_FAILED=1
      assert_admin_path() { return 1; }
      if preserve_failed_recovery; then echo "Failed retention returned success"; exit 1; fi
      [[ "$RECOVERY_RETAINED" == 0 && -f "$CONFIG_BACKUP" && "$(command stat -c %a "$TEMP_DIR")" == 700 ]]
      cmp -s "$CONFIG_BACKUP" "$FIXTURE/expected.env"
    ' > "$work/output" 2>&1
    ! grep -q fixture-preserved-token "$work/output"
    mkdir -p "$work/data/command-bridge-recovery"
    if bash -c 'source "$FIXTURE/common.sh"; trap - EXIT ERR; assert_admin_path() { :; }; find() { return 93; }; assert_no_pending_recovery' > "$work/output" 2>&1; then echo 'Unreadable recovery directory was ignored'; exit 1; fi
    grep -q 'Cannot inspect installer recovery directory' "$work/output"
    ;;
  uninstall)
    prepare
    root="$work/data/command-bridge-recovery"
    mkdir -p "$root/failed.fixture/snapshots" "$work/data/command-bridge/work"
    printf 'schemaVersion=1\n' > "$root/failed.fixture/snapshots/context"
    printf 'private-snapshot\n' > "$root/failed.fixture/snapshots/config"
    printf 'work\n' > "$work/data/command-bridge/work/preserved"
    chmod 0700 "$root" "$root/failed.fixture" "$root/failed.fixture/snapshots"
    chmod 0600 "$root/failed.fixture/snapshots/"*
    cat > "$work/uninstall-common.sh" <<'SH'
source "$FIXTURE/uninstall.sh"
trap - ERR
require_root_systemd_linux() { :; }
acquire_lock() { :; }
stat() { if [[ "$1" == -c && "$2" == %u ]]; then echo 0; elif [[ "$1" == -c && "$2" == %a ]]; then echo 755; else command stat "$@"; fi; }
systemctl() { [[ "$1" == daemon-reload || "$1" == reset-failed ]]; }
getent() { return 2; }
SH
    for fault in writable symlink metadata hidden; do
      if FAULT=$fault bash -c '
        source "$FIXTURE/uninstall-common.sh"
        case "$FAULT" in
          writable) chmod 0666 "$FIXTURE/data/command-bridge-recovery/failed.fixture/snapshots/config" ;;
          symlink) ln -s "$FIXTURE/expected.env" "$FIXTURE/data/command-bridge-recovery/escape" ;;
          metadata) printf unknown > "$FIXTURE/data/command-bridge-recovery/failed.fixture/snapshots/context" ;;
          hidden) printf unknown > "$FIXTURE/data/command-bridge-recovery/.unknown" ;;
        esac
        main --purge --yes
      ' > "$work/output" 2>&1; then echo 'Unsafe purge accepted'; exit 1; fi
      [[ -f "$root/failed.fixture/snapshots/config" && -f "$work/config/command-bridge.env" ]]
      chmod 0600 "$root/failed.fixture/snapshots/config"
      rm -f "$root/escape"
      rm -f "$root/.unknown"
      printf 'schemaVersion=1\n' > "$root/failed.fixture/snapshots/context"
    done
    bash -c 'source "$FIXTURE/uninstall-common.sh"; main --yes' > "$work/output" 2>&1
    [[ -f "$root/failed.fixture/snapshots/config" && -f "$work/data/command-bridge/work/preserved" ]]
    cmp -s "$work/config/command-bridge.env" "$work/expected.env"
    bash -c 'source "$FIXTURE/uninstall-common.sh"; main --purge --yes' > "$work/output" 2>&1
    [[ ! -e "$root" && ! -e "$work/config" && ! -e "$work/data/command-bridge" ]]
    ;;
  *) echo 'Unknown recovery fixture'; exit 1 ;;
esac
printf 'Recovery fixture %s passed.\n' "$1"
