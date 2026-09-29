#!/usr/bin/env bash
# Exercise the opt-in account/configuration transition without changing host services.
set -Eeuo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/home/alice" "$work/source/packaging" "$work/helpers" "$work/sudoers"
cp packaging/policy.example.json "$work/source/packaging/policy.example.json"
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
getent() {
  if [[ "$1" == passwd && "$2" == alice ]]; then
    printf 'alice:x:12345:12346::%s/home/alice:/bin/bash\n' "$work"
    return 0
  fi
  command getent "$@"
}
install() {
  local -a args=()
  while (( $# )); do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  command install "${args[@]}"
}
chown() { :; }
SUDO_USER=alice SUDO_UID=12345
RUN_AS_INSTALLER=1
select_service_identity
[[ "$INSTALLER_UID" == 12345 && "$INSTALLER_GID" == 12346 ]]
[[ "$INSTALLER_HOME" == "$work/home/alice" ]]
if ( SUDO_USER='' select_service_identity ) > "$work/failure" 2>&1; then
  echo 'Direct root execution incorrectly selected an installer account.' >&2; exit 1
fi
if ( RUN_AS_INSTALLER=0 ENABLE_UNRESTRICTED=1 select_service_identity ) > "$work/failure" 2>&1; then
  echo 'Unrestricted mode incorrectly accepted without opt-in identity.' >&2; exit 1
fi
TEMP_DIR=$work
ensure_installer_state
[[ -d "$INSTALLER_STATE_DIR" && ! -e "$INSTALLER_STATE_DIR/CommandBridgeMCP" ]]
mkdir "$work/outside"
chmod 0700 "$work/outside"
ln -s "$work/outside" "$INSTALLER_STATE_DIR/CommandBridgeMCP"
ensure_installer_state
[[ "$(stat -c '%a' "$work/outside")" == 700 ]]
[[ ! -e "$work/outside/audit" ]]
rm "$INSTALLER_STATE_DIR/CommandBridgeMCP"
COMMAND_BRIDGE_BEARER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mkdir -p "$(dirname "$CONFIG_FILE")"
install_configuration
grep -Fxq 'COMMAND_BRIDGE_AUDIT_BACKEND=file' "$CONFIG_FILE"
grep -Fxq "COMMAND_BRIDGE_ALLOWED_ROOTS=${INSTALLER_HOME}:/" "$CONFIG_FILE"
grep -Fxq 'COMMAND_BRIDGE_EXECUTION_MODE=allowlist' "$CONFIG_FILE"
cp "$CONFIG_FILE" "$work/original.env"
sed -i 's/COMMAND_BRIDGE_AUDIT_BACKEND=file/COMMAND_BRIDGE_AUDIT_BACKEND=journal/; s|^COMMAND_BRIDGE_ALLOWED_ROOTS=.*|COMMAND_BRIDGE_ALLOWED_ROOTS=/var/lib/command-bridge/work|' "$CONFIG_FILE"
cp "$CONFIG_FILE" "$work/previous.env"
ENABLE_UNRESTRICTED=1
install_configuration
cmp "$work/previous.env" "$CONFIG_BACKUP"
grep -Fxq 'COMMAND_BRIDGE_AUDIT_BACKEND=file' "$CONFIG_FILE"
grep -Fxq 'COMMAND_BRIDGE_EXECUTION_MODE=unrestricted' "$CONFIG_FILE"
grep -Fxq "COMMAND_BRIDGE_ALLOWED_ROOTS=${INSTALLER_HOME}:/" "$CONFIG_FILE"
grep -Fxq "COMMAND_BRIDGE_BEARER_TOKEN=${COMMAND_BRIDGE_BEARER_TOKEN}" "$CONFIG_FILE"
EXISTING_INSTALLER_MODE=1 ENABLE_UNRESTRICTED=0
sed -i "s|^COMMAND_BRIDGE_ALLOWED_ROOTS=.*|COMMAND_BRIDGE_ALLOWED_ROOTS=${INSTALLER_HOME}|" "$CONFIG_FILE"
cp "$CONFIG_FILE" "$work/custom.env"
install_configuration
cmp "$work/custom.env" "$CONFIG_FILE"

mkdir -p "$AUDIT_READER_DIR" "$(dirname "$AUDIT_SUDOERS_FILE")"
printf 'original helper\n' > "$AUDIT_READER_PATH"
printf 'original rule\n' > "$AUDIT_SUDOERS_FILE"
remove_audit_access_for_installer
[[ ! -e "$AUDIT_READER_PATH" && ! -e "$AUDIT_SUDOERS_FILE" ]]
rollback_audit_access
grep -Fxq 'original helper' "$AUDIT_READER_PATH"
grep -Fxq 'original rule' "$AUDIT_SUDOERS_FILE"

sed -e "s/__INSTALLER_UID__/${INSTALLER_UID}/g" -e "s/__INSTALLER_GID__/${INSTALLER_GID}/g" \
  packaging/systemd/command-bridge-installer.service > "$work/rendered.service"
grep -Fxq "User=${INSTALLER_UID}" "$work/rendered.service"
grep -Fxq "Group=${INSTALLER_GID}" "$work/rendered.service"
grep -Fxq 'Environment=XDG_DATA_HOME=/var/lib/command-bridge-installer' "$work/rendered.service"
! grep -q '__INSTALLER_' "$work/rendered.service"
echo 'Installer-account behavior checks passed.'
