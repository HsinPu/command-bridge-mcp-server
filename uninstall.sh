#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly SERVICE_NAME="command-bridge-mcp-server"
readonly SERVICE_USER="command-bridge"
readonly SERVICE_GROUP="command-bridge"
readonly SERVICE_HOME="/var/empty/command-bridge"
readonly INSTALL_ROOT="/opt/command-bridge-mcp-server"
readonly CONFIG_DIR="/etc/command-bridge-mcp-server"
readonly STATE_DIR="/var/lib/command-bridge-mcp-server"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
readonly LOCK_DIR="/run/command-bridge-mcp-server"
readonly LOCK_FILE="${LOCK_DIR}/install.lock"

PURGE=0
ASSUME_YES=0
DRY_RUN=0
SHOW_HELP=0

log() {
  printf '[CommandBridge] %s\n' "$*"
}

warn() {
  printf '[CommandBridge] WARNING: %s\n' "$*" >&2
}

fail() {
  printf '[CommandBridge] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage: sudo bash uninstall.sh [options]' \
    '' \
    'Remove CommandBridge MCP from a systemd-based Linux host.' \
    '' \
    'Options:' \
    '  --yes, -y   Skip the interactive confirmation.' \
    '  --purge     Also permanently delete configuration, work data, the service' \
    '              account, its group, and its home directory.' \
    '  --dry-run   Print the actions without changing the host.' \
    '  --help, -h  Show this help text.' \
    '' \
    'Without --purge, the uninstaller preserves:' \
    '  /etc/command-bridge-mcp-server' \
    '  /var/lib/command-bridge-mcp-server' \
    '  command-bridge service account and group'
}

on_error() {
  local exit_code=$?
  trap - ERR
  printf '[CommandBridge] Uninstallation stopped near line %s (exit %s).\n' \
    "${BASH_LINENO[0]:-unknown}" "${exit_code}" >&2
  exit "${exit_code}"
}

trap on_error ERR

parse_arguments() {
  while (( $# > 0 )); do
    case "$1" in
      --yes | -y)
        ASSUME_YES=1
        ;;
      --purge)
        PURGE=1
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --help | -h)
        SHOW_HELP=1
        ;;
      *)
        usage >&2
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_root_systemd_linux() {
  [[ "${EUID}" -eq 0 ]] || \
    fail "Run this uninstaller as root, for example: sudo bash uninstall.sh"
  [[ "$(uname -s)" == "Linux" ]] || fail "This uninstaller supports Linux only."

  require_command systemctl
  [[ -d /run/systemd/system ]] || fail "systemd is not running as PID 1 on this host."
}

run_command() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[CommandBridge] [dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return
  fi

  "$@"
}

acquire_lock() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "Dry-run mode does not acquire or modify the installation lock."
    return
  fi

  install -d -m 0700 -o root -g root "${LOCK_DIR}"
  exec 9>"${LOCK_FILE}"
  chmod 0600 "${LOCK_FILE}"
  flock -n 9 || fail "Another CommandBridge install or uninstall operation is running."
}

print_plan() {
  printf '\n'
  log "Planned removal:"
  printf '  Service and unit: %s.service\n' "${SERVICE_NAME}"
  printf '  Application: %s\n' "${INSTALL_ROOT}"

  if [[ "${PURGE}" == "1" ]]; then
    printf '  Configuration: %s\n' "${CONFIG_DIR}"
    printf '  Work data: %s\n' "${STATE_DIR}"
    printf '  Service identity: %s:%s\n' "${SERVICE_USER}" "${SERVICE_GROUP}"
    printf '  Service home: %s\n' "${SERVICE_HOME}"
    warn "--purge permanently deletes the bearer token and all CommandBridge work data."
  else
    printf '\n'
    log "Preserved:"
    printf '  Configuration: %s\n' "${CONFIG_DIR}"
    printf '  Work data: %s\n' "${STATE_DIR}"
    printf '  Service identity: %s:%s\n' "${SERVICE_USER}" "${SERVICE_GROUP}"
  fi
  printf '\n'
}

confirm_removal() {
  local expected reply

  if [[ "${DRY_RUN}" == "1" || "${ASSUME_YES}" == "1" ]]; then
    return
  fi

  [[ -t 0 ]] || \
    fail "Interactive confirmation is unavailable. Re-run with --yes after reviewing the plan."

  expected="uninstall"
  if [[ "${PURGE}" == "1" ]]; then
    expected="purge"
  fi

  printf 'Type "%s" to continue: ' "${expected}"
  read -r reply
  if [[ "${reply}" != "${expected}" ]]; then
    log "Uninstallation cancelled; no changes were made."
    exit 0
  fi
}

assert_safe_tree_path() {
  case "$1" in
    "${INSTALL_ROOT}" | "${CONFIG_DIR}" | "${STATE_DIR}" | "${SERVICE_HOME}")
      ;;
    *)
      fail "Refusing to remove an unexpected path: $1"
      ;;
  esac
}

remove_tree() {
  local path=$1

  assert_safe_tree_path "${path}"
  assert_tree_is_not_mounted "${path}"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    log "Already absent: ${path}"
    return
  fi

  if [[ -L "${path}" ]]; then
    run_command rm -f -- "${path}"
  else
    run_command rm -rf --one-file-system -- "${path}"
  fi
}

assert_tree_is_not_mounted() {
  local path=$1

  assert_safe_tree_path "${path}"
  if [[ ( -e "${path}" || -L "${path}" ) ]] && \
    command -v mountpoint >/dev/null 2>&1 && \
    mountpoint -q "${path}"; then
    fail "Refusing to remove a mounted path: ${path}"
  fi
}

inspect_installed_unit() {
  local fragment_path

  if [[ -e "${UNIT_FILE}" || -L "${UNIT_FILE}" ]]; then
    [[ -f "${UNIT_FILE}" && ! -L "${UNIT_FILE}" ]] || \
      fail "Expected a regular systemd unit at ${UNIT_FILE}; inspect it manually."
  fi

  fragment_path=$(systemctl show \
    --property=FragmentPath \
    --value \
    "${SERVICE_NAME}.service" 2>/dev/null || true)
  if [[ -n "${fragment_path}" && "${fragment_path}" != "${UNIT_FILE}" ]]; then
    fail "Refusing to manage an unexpected systemd unit at ${fragment_path}."
  fi
}

stop_disable_and_remove_service() {
  inspect_installed_unit

  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    run_command systemctl stop "${SERVICE_NAME}.service"
  else
    log "Service is already inactive."
  fi

  if systemctl is-enabled --quiet "${SERVICE_NAME}.service"; then
    run_command systemctl disable "${SERVICE_NAME}.service"
  else
    log "Service is already disabled or absent."
  fi

  if [[ -e "${UNIT_FILE}" || -L "${UNIT_FILE}" ]]; then
    run_command rm -f -- "${UNIT_FILE}"
  else
    log "Already absent: ${UNIT_FILE}"
  fi

  run_command systemctl daemon-reload

  if [[ "${DRY_RUN}" == "1" ]]; then
    run_command systemctl reset-failed "${SERVICE_NAME}.service"
    return
  fi

  systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    fail "The service is still active; application files were not removed."
  fi
  if systemctl is-enabled --quiet "${SERVICE_NAME}.service"; then
    fail "The service is still enabled; application files were not removed."
  fi
}

validate_service_identity_for_purge() {
  local account_entry account_name account_uid account_gid account_home account_shell
  local primary_group all_groups group_entry group_name group_gid group_members member
  local -a members

  account_entry=$(getent passwd "${SERVICE_USER}" || true)
  group_entry=$(getent group "${SERVICE_GROUP}" || true)

  if [[ -n "${account_entry}" ]]; then
    IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell \
      <<< "${account_entry}"
    [[ "${account_name}" == "${SERVICE_USER}" ]] || fail "Unexpected service account record."
    [[ "${account_uid}" != "0" ]] || fail "Refusing to remove a UID 0 account."
    [[ "${account_home}" == "${SERVICE_HOME}" ]] || \
      fail "Service account has an unexpected home directory: ${account_home}"
    case "${account_shell}" in
      */nologin | /bin/false)
        ;;
      *)
        fail "Service account has an unexpected login shell: ${account_shell}"
        ;;
    esac

    primary_group=$(id -gn "${SERVICE_USER}")
    all_groups=$(id -nG "${SERVICE_USER}")
    [[ "${primary_group}" == "${SERVICE_GROUP}" ]] || \
      fail "Service account has an unexpected primary group: ${primary_group}"
    [[ "${all_groups}" == "${SERVICE_GROUP}" ]] || \
      fail "Service account has extra groups; remove those memberships manually first."

    if pgrep -u "${account_uid}" >/dev/null 2>&1; then
      if [[ "${DRY_RUN}" == "1" ]]; then
        warn "The service account currently has processes; the real uninstall must stop them first."
      else
        fail "The service account still has running processes; refusing to purge it."
      fi
    fi
  fi

  if [[ -n "${group_entry}" ]]; then
    IFS=: read -r group_name _ group_gid group_members <<< "${group_entry}"
    [[ "${group_name}" == "${SERVICE_GROUP}" ]] || fail "Unexpected service group record."

    members=()
    if [[ -n "${group_members}" ]]; then
      IFS=',' read -r -a members <<< "${group_members}"
    fi
    for member in "${members[@]}"; do
      [[ -z "${member}" || "${member}" == "${SERVICE_USER}" ]] || \
        fail "Service group contains another member: ${member}"
    done

    if getent passwd | awk -F: \
      -v gid="${group_gid}" \
      -v service_user="${SERVICE_USER}" \
      '$4 == gid && $1 != service_user { found = 1 } END { exit found ? 0 : 1 }'; then
      fail "Another account uses ${SERVICE_GROUP} as its primary group."
    fi

    if [[ -n "${account_entry}" && "${account_gid}" != "${group_gid}" ]]; then
      fail "Service account and group IDs do not match."
    fi
  elif [[ -n "${account_entry}" ]]; then
    fail "Service account exists but its expected group is missing."
  fi
}

remove_service_identity() {
  if getent passwd "${SERVICE_USER}" >/dev/null 2>&1; then
    run_command userdel "${SERVICE_USER}"
  else
    log "Service account is already absent."
  fi

  if getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    run_command groupdel "${SERVICE_GROUP}"
  else
    log "Service group is already absent."
  fi
}

print_summary() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "Dry run complete; no changes were made."
    return
  fi

  log "Uninstallation complete."
  printf '\n'
  printf '  Removed service: %s.service\n' "${SERVICE_NAME}"
  printf '  Removed application: %s\n' "${INSTALL_ROOT}"

  if [[ "${PURGE}" == "1" ]]; then
    printf '  Purged configuration: %s\n' "${CONFIG_DIR}"
    printf '  Purged work data: %s\n' "${STATE_DIR}"
    printf '  Removed service identity: %s:%s\n' "${SERVICE_USER}" "${SERVICE_GROUP}"
  else
    printf '\n'
    printf 'Preserved for a future reinstall:\n'
    printf '  %s\n' "${CONFIG_DIR}"
    printf '  %s\n' "${STATE_DIR}"
    printf '  %s:%s\n' "${SERVICE_USER}" "${SERVICE_GROUP}"
    printf '\n'
    printf 'To delete those items too, re-run this script with --purge --yes.\n'
  fi
}

main() {
  parse_arguments "$@"
  if [[ "${SHOW_HELP}" == "1" ]]; then
    usage
    return
  fi

  require_root_systemd_linux
  for command_name in chmod flock install rm systemctl uname; do
    require_command "${command_name}"
  done
  if [[ "${PURGE}" == "1" ]]; then
    for command_name in awk getent groupdel id pgrep userdel; do
      require_command "${command_name}"
    done
  fi

  acquire_lock
  print_plan
  confirm_removal

  assert_tree_is_not_mounted "${INSTALL_ROOT}"
  if [[ "${PURGE}" == "1" ]]; then
    assert_tree_is_not_mounted "${CONFIG_DIR}"
    assert_tree_is_not_mounted "${STATE_DIR}"
    assert_tree_is_not_mounted "${SERVICE_HOME}"
  fi

  stop_disable_and_remove_service
  if [[ "${PURGE}" == "1" ]]; then
    validate_service_identity_for_purge
  fi
  remove_tree "${INSTALL_ROOT}"

  if [[ "${PURGE}" == "1" ]]; then
    remove_service_identity
    remove_tree "${CONFIG_DIR}"
    remove_tree "${STATE_DIR}"
    remove_tree "${SERVICE_HOME}"
  fi

  print_summary
}

main "$@"
