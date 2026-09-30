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
    -e "s|/etc/passwd|${work}/passwd|g" \
    -e "s|/etc/login.defs|${work}/login.defs|g" \
    scripts/linux-systemd/install.sh > "$work/installer.sh"
source "$work/installer.sh"
trap - EXIT ERR
trap 'rm -rf -- "$work"' EXIT
getent() {
  if [[ "$1" == passwd && "$2" == alice ]]; then
    printf 'alice:x:12345:12346::%s/home/alice:/bin/bash\n' "$work"
    return 0
  fi
  if [[ "$1 $2" == 'passwd command-bridge' ]]; then
    [[ "${old_present:-0}" == 1 ]] || return 2
    cat "$work/passwd"
    return 0
  fi
  if [[ "$1 $2" == 'group command-bridge' ]]; then printf 'command-bridge:x:982:\n'; return 0; fi
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
printf 'UID_MIN 1000\n' > "$work/login.defs"
useradd() { echo 'Installer mode must not create a service user.' >&2; return 1; }
groupadd() { echo 'Existing policy-reader group must be preserved.' >&2; return 1; }
ensure_service_account
[[ ! -e "$STATE_DIR" && ! -e "$SERVICE_HOME" ]]
old_present=1
printf 'command-bridge:x:988:982::%s:/usr/sbin/nologin\n' "$SERVICE_HOME" > "$work/passwd"
id() {
  if [[ "$2" == command-bridge ]]; then printf '%s\n' "${mock_groups:-command-bridge}"; else command id "$@"; fi
}
systemctl() {
  case "$1" in show) printf '%s\n' "${INSTALLER_UID}" ;; is-active) return 0 ;; *) return 1 ;; esac
}
pgrep() { return "${mock_process_status:-1}"; }
userdel() {
  [[ "$*" == command-bridge ]] || return 1
  [[ "${mock_delete_failure:-0}" == 0 ]] || return 1
  old_present=0
}
ensure_service_account
printf 'preserved work\n' > "$work/preserved"
if (remove_unused_service_account) > "$work/failure" 2>&1; then echo 'Unverified installation deleted the account.'; exit 1; fi
INSTALL_SUCCEEDED=1
for mock_process_status in 0 2; do
  if (remove_unused_service_account) > "$work/failure" 2>&1; then echo 'Unsafe process cleanup accepted.'; exit 1; fi
  [[ "$old_present" == 1 ]]
done
mock_process_status=1 mock_groups='command-bridge wheel'
if (remove_unused_service_account) > "$work/failure" 2>&1; then echo 'Privileged account deletion accepted.'; exit 1; fi
mock_groups=command-bridge mock_delete_failure=1
if (remove_unused_service_account) > "$work/failure" 2>&1; then echo 'userdel failure was hidden.'; exit 1; fi
mock_delete_failure=0
for record in 'command-bridge:x:0:982::HOME:/usr/sbin/nologin' 'command-bridge:x:1001:982::HOME:/usr/sbin/nologin' 'command-bridge:x:988:982::/home/someone:/usr/sbin/nologin' 'command-bridge:x:988:982::HOME:/bin/bash'; do
  printf '%s\n' "${record//HOME/$SERVICE_HOME}" > "$work/passwd"
  if (validate_unused_service_account) > "$work/failure" 2>&1; then echo 'Unrelated account accepted for deletion.'; exit 1; fi
done
printf 'command-bridge:x:988:982::%s:/usr/sbin/nologin\n' "$SERVICE_HOME" > "$work/passwd"
remove_unused_service_account
[[ "$old_present" == 0 && "$(cat "$work/preserved")" == 'preserved work' ]]
remove_unused_service_account
old_present=1 group_present=1
getent() {
  case "$1 $2" in
    'passwd command-bridge') [[ "$old_present" == 1 ]] || return 2; cat "$work/passwd" ;;
    'group command-bridge') [[ "$group_present" == 1 ]] || return 2; printf 'command-bridge:x:982:\n' ;;
    'passwd alice') printf 'alice:x:12345:12346::%s/home/alice:/bin/bash\n' "$work" ;;
    *) command getent "$@" ;;
  esac
}
userdel() { [[ "$*" == command-bridge ]] || return 1; old_present=0 group_present=0; }
groupadd() { [[ "$*" == '--system --gid 982 command-bridge' ]] || return 1; group_present=1; }
remove_unused_service_account
[[ "$old_present" == 0 && "$group_present" == 1 ]]
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
AUDIT_ACCESS_INSTALLED=0
rollback_audit_access

sed -e "s/__INSTALLER_UID__/${INSTALLER_UID}/g" -e "s/__INSTALLER_GID__/${INSTALLER_GID}/g" \
  packaging/systemd/command-bridge-installer.service > "$work/rendered.service"
grep -Fxq "User=${INSTALLER_UID}" "$work/rendered.service"
grep -Fxq "Group=${INSTALLER_GID}" "$work/rendered.service"
grep -Fxq 'Environment=XDG_DATA_HOME=/var/lib/command-bridge-installer' "$work/rendered.service"
! grep -q '__INSTALLER_' "$work/rendered.service"
echo 'Installer-account behavior checks passed.'
