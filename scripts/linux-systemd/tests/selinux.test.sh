#!/usr/bin/env bash
# Behavioral tests use fake labeling tools; no host labels/services are changed.
set -Eeuo pipefail
work=$(mktemp -d)
sed -e "s|/opt/command-bridge|${work}/opt/command-bridge|g" \
    -e "s|/etc/command-bridge|${work}/etc/command-bridge|g" \
    -e "s|/var/lib/command-bridge|${work}/state/command-bridge|g" \
    -e "s|/var/empty/command-bridge|${work}/home/command-bridge|g" \
    -e "s|/etc/systemd/system/|${work}/units/|g" \
    -e "s|/usr/local/libexec/|${work}/helpers/|g" \
    -e "s|/etc/sudoers.d/|${work}/sudoers/|g" \
    scripts/linux-systemd/install.sh > "$work/installer.sh"
source "$work/installer.sh"
trap - EXIT ERR
trap 'rm -rf -- "$work"' EXIT
export LABEL_EVENTS="$work/events" LABEL_STATE="$work/labels"
export MOCK_MODE=Enforcing MOCK_FAIL_RESTORE='' MOCK_FAIL_VERIFY=''
mkdir "$work/bin"
touch "$LABEL_EVENTS" "$LABEL_STATE"
cat > "$work/bin/getenforce" <<'SH'
#!/usr/bin/env bash
[[ "$MOCK_MODE" != error ]] || exit 1
echo "$MOCK_MODE"
SH
cat > "$work/bin/restorecon" <<'SH'
#!/usr/bin/env bash
set -eu
for path do
  # Oracle Linux 8 restorecon has no -x option. Reject recursive/unknown flags
  # so this fixture catches host compatibility errors before activation.
  [[ "$path" != -* ]] || { echo "unsupported restorecon option: $path" >&2; exit 2; }
  printf 'restore %s\n' "$path" >> "$LABEL_EVENTS"
  [[ "$path" != "$MOCK_FAIL_RESTORE" ]] || exit 1
  printf '%s\n' "$path" >> "$LABEL_STATE"
done
SH
cat > "$work/bin/matchpathcon" <<'SH'
#!/usr/bin/env bash
set -eu
shift
for path do
  printf 'verify %s\n' "$path" >> "$LABEL_EVENTS"
  [[ "$path" != "$MOCK_FAIL_VERIFY" ]] || exit 1
  grep -Fxq "$path" "$LABEL_STATE" || exit 1
done
SH
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
# Strip ownership flags only; exercise real install/copy/link operations in /tmp.
install() {
  local -a args=()
  while (( $# )); do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  command install "${args[@]}"
}
systemctl() { printf 'systemctl %s\n' "$*" >> "$LABEL_EVENTS"; }
expect_failure() {
  if ( "$@" ) > "$work/failure" 2>&1; then echo "Unexpected success: $*"; exit 1; fi
}

MOCK_MODE=Disabled
detect_selinux
restore_selinux_path "$work"
[[ "$SELINUX_ACTIVE" == 0 && ! -s "$LABEL_EVENTS" ]]
for MOCK_MODE in Enforcing Permissive; do
  detect_selinux
  [[ "$SELINUX_ACTIVE" == 1 ]]
done
MOCK_MODE=error; expect_failure detect_selinux
MOCK_MODE=Unknown; expect_failure detect_selinux
MOCK_MODE=Enforcing
# A present SELinux installation must not silently skip missing tools.
expect_failure bash -c 'source "$1"; trap - EXIT ERR; command() { if [[ "$1 $2" == "-v restorecon" ]]; then return 1; fi; builtin command "$@"; }; detect_selinux' _ "$work/installer.sh"
detect_selinux

BUILT_PACKAGE_VERSION=3.0.0
SOURCE_REF=1111111111111111111111111111111111111111
runtime="$RUNTIME_DIR/node-v${NODE_VERSION}-linux-x64"
release="$RELEASES_DIR/v${BUILT_PACKAGE_VERSION}-${SOURCE_REF}"
mkdir -p "$runtime/bin" "$release" "$CONFIG_DIR" "$WORK_DIR_PATH" "$(dirname "$UNIT_FILE")" "$SERVICE_HOME"
printf '%s\n' "$SOURCE_REF" > "$release/.command-bridge-release"
printf 'preserved token\n' > "$CONFIG_FILE"
printf '{}\n' > "$CONFIG_DIR/policy.json"
printf 'user data\n' > "$WORK_DIR_PATH/preserved"
printf 'outside\n' > "$work/outside"
ln -s "$work/outside" "$release/outside-link"
cat > "$runtime/bin/node" <<'SH'
#!/usr/bin/env bash
grep -Fxq "$0" "$LABEL_STATE" || { echo 'Runtime executed before label repair' >&2; exit 1; }
echo v24.18.0
SH
chmod +x "$runtime/bin/node"

# Reuse a runtime left by a failed install: it must be repaired before execution.
install_runtime_and_release x64
[[ "$(readlink "$CURRENT_LINK")" == "$release" ]]
[[ "$(readlink "$RUNTIME_LINK")" == "$runtime" ]]
! grep -Fxq "$WORK_DIR_PATH/preserved" "$LABEL_STATE"
! grep -Fxq "$work/outside" "$LABEL_STATE"
grep -Fxq 'preserved token' "$CONFIG_FILE"
expect_failure restore_selinux_path "$CURRENT_LINK" 1

# Fresh deployment exercises real copy operations, not only existing releases.
TEMP_DIR="$work/staging"
mkdir -p "$TEMP_DIR/node-runtime/bin" "$TEMP_DIR/source/dist" "$TEMP_DIR/source/node_modules" \
  "$TEMP_DIR/source/scripts/linux-systemd"
cp "$runtime/bin/node" "$TEMP_DIR/node-runtime/bin/node"
for file in package.json package-lock.json README.md SECURITY.md scripts/verify-install.mjs scripts/linux-systemd/uninstall.sh; do
  printf 'fixture\n' > "$TEMP_DIR/source/$file"
done
chown() { :; }
SOURCE_REF=2222222222222222222222222222222222222222
install_runtime_and_release arm64
[[ "$("$RUNTIME_DIR/node-v${NODE_VERSION}-linux-arm64/bin/node")" == v24.18.0 ]]
[[ -f "$CURRENT_LINK/install-info.json" ]]
SOURCE_REF=1111111111111111111111111111111111111111

# Missing labeling/verification means no activation links are created.
ACTIVATION_STARTED=0
unlink "$CURRENT_LINK"; unlink "$RUNTIME_LINK"
MOCK_FAIL_RESTORE="$runtime"
expect_failure install_runtime_and_release x64
[[ ! -L "$CURRENT_LINK" && ! -L "$RUNTIME_LINK" ]]
MOCK_FAIL_RESTORE=''; MOCK_FAIL_VERIFY="$runtime/bin/node"
expect_failure install_runtime_and_release x64
[[ ! -L "$CURRENT_LINK" && ! -L "$RUNTIME_LINK" ]]
MOCK_FAIL_VERIFY=''

# Unit relabel failure must prevent daemon reload/start even after preparation.
printf '[Service]\n' > "$TEMP_DIR/$SERVICE_NAME.service"
MOCK_FAIL_RESTORE="$UNIT_FILE"
: > "$LABEL_EVENTS"
expect_failure install_and_start_service
! grep -q '^systemctl ' "$LABEL_EVENTS"
MOCK_FAIL_RESTORE=''

# Restored files/links must be relabeled before the old service is restarted.
PREVIOUS_RELEASE="$release"; PREVIOUS_RUNTIME="$runtime"
CONFIG_BACKUP="$work/previous.env"
printf 'preserved token\n' > "$CONFIG_BACKUP"
printf 'candidate token\n' > "$CONFIG_FILE"
ACTIVATION_STARTED=1
: > "$LABEL_EVENTS"
rollback_activation || exit 1
grep -Fxq 'preserved token' "$CONFIG_FILE"
grep -Fxq 'systemctl restart command-bridge.service' "$LABEL_EVENTS"
last_verify=$(grep -n '^verify ' "$LABEL_EVENTS" | tail -1 | cut -d: -f1)
restart=$(grep -n '^systemctl restart ' "$LABEL_EVENTS" | cut -d: -f1)
(( last_verify < restart ))
MOCK_FAIL_RESTORE="$INSTALL_ROOT"
: > "$LABEL_EVENTS"
ACTIVATION_STARTED=1
rollback_activation > "$work/rollback-warning" || exit 1
grep -Fxq 'systemctl stop command-bridge.service' "$LABEL_EVENTS"
! grep -q '^systemctl restart ' "$LABEL_EVENTS"
grep -q 'restored service was not restarted' "$work/rollback-warning"
MOCK_FAIL_RESTORE=''

# Migration rollback must label the old paths, after moving directories back.
LEGACY_MIGRATION=1; LEGACY_APP_PRESENT=1; LEGACY_CONFIG_PRESENT=1; LEGACY_STATE_PRESENT=1
LEGACY_WAS_ACTIVE=1; LEGACY_WAS_ENABLED=1
LEGACY_CURRENT_TARGET="${release/$INSTALL_ROOT/$LEGACY_INSTALL_ROOT}"
LEGACY_RUNTIME_TARGET="${runtime/$INSTALL_ROOT/$LEGACY_INSTALL_ROOT}"
ln -s "$INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"
ln -s "$CONFIG_DIR" "$LEGACY_CONFIG_DIR"
ln -s "$STATE_DIR" "$LEGACY_STATE_DIR"
: > "$LABEL_EVENTS"
rollback_activation || exit 1
[[ -d "$LEGACY_INSTALL_ROOT" && ! -L "$LEGACY_INSTALL_ROOT" ]]
[[ -f "$LEGACY_STATE_DIR/work/preserved" ]]
grep -Fxq "restore $LEGACY_INSTALL_ROOT" "$LABEL_EVENTS"
grep -Fxq 'systemctl restart command-bridge-mcp-server.service' "$LABEL_EVENTS"
! grep -Fxq "$LEGACY_STATE_DIR/work/preserved" "$LABEL_STATE"
echo 'SELinux detection, fail-closed activation, runtime reuse, traversal boundaries and rollback passed.'
