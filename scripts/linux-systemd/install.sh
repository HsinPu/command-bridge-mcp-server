#!/usr/bin/env bash

set -Eeuo pipefail

readonly SERVICE_NAME="command-bridge"
readonly SERVICE_USER="command-bridge"
readonly SERVICE_GROUP="command-bridge"
readonly SERVICE_HOME="/var/empty/command-bridge"
readonly INSTALL_ROOT="/opt/command-bridge"
readonly RELEASES_DIR="${INSTALL_ROOT}/releases"
readonly RUNTIME_DIR="${INSTALL_ROOT}/runtime"
readonly CURRENT_LINK="${INSTALL_ROOT}/current"
readonly RUNTIME_LINK="${RUNTIME_DIR}/current"
readonly CONFIG_DIR="/etc/command-bridge"
readonly CONFIG_FILE="${CONFIG_DIR}/command-bridge.env"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
readonly STATE_DIR="/var/lib/command-bridge"
readonly INSTALLER_STATE_DIR="/var/lib/command-bridge-installer"
readonly WORK_DIR_PATH="${STATE_DIR}/work"
readonly AUDIT_READER_DIR="/usr/local/libexec/command-bridge"
readonly AUDIT_READER_PATH="${AUDIT_READER_DIR}/audit-reader"
readonly AUDIT_SUDOERS_FILE="/etc/sudoers.d/command-bridge-audit-reader"
# The existing lock name is kept so an older installer cannot race migration.
readonly LOCK_DIR="/run/command-bridge-mcp-server"
readonly LEGACY_SERVICE_NAME="command-bridge-mcp-server"
readonly LEGACY_UNIT_FILE="/etc/systemd/system/${LEGACY_SERVICE_NAME}.service"
readonly LEGACY_INSTALL_ROOT="/opt/command-bridge-mcp-server"
readonly LEGACY_CONFIG_DIR="/etc/command-bridge-mcp-server"
readonly LEGACY_STATE_DIR="/var/lib/command-bridge-mcp-server"
readonly LEGACY_AUDIT_READER_DIR="/usr/local/libexec/command-bridge-mcp-server"
readonly LEGACY_AUDIT_SUDOERS_FILE="/etc/sudoers.d/command-bridge-mcp-server-audit-reader"
SOURCE_REF=""
readonly NODE_VERSION="24.18.0"
readonly NODE_RELEASE_BASE="https://nodejs.org/download/release/v${NODE_VERSION}"
readonly SYSTEMD_UNIT_SHA256="1745d6fc446b0af776e45b76d648cef21938da44e39b0c3730c36cf1c21a5e00"
readonly INSTALLER_UNIT_SHA256="9b1cc2cc158be63113fe5f30d832ab81de8377aceaf5d0d7ca3a2d3047f8519d"
readonly AUDIT_READER_SHA256="58b2381e2a5ff3284f81c6916fca9d8bac80eaaa836fa2b4b7c851519acc7e49"
readonly BUILD_USER="command-bridge-build-$$"
readonly BUILD_GROUP="${BUILD_USER}"

TEMP_DIR=""
PREVIOUS_RELEASE=""
PREVIOUS_RUNTIME=""
ACTIVATION_STARTED=0
ROLLBACK_IN_PROGRESS=0
PREVIOUS_UNIT_BACKUP=""
UNIT_WAS_PRESENT=0
PREVIOUS_AUDIT_READER_BACKUP=""
AUDIT_READER_WAS_PRESENT=0
PREVIOUS_AUDIT_SUDOERS_BACKUP=""
AUDIT_SUDOERS_WAS_PRESENT=0
AUDIT_READER_DIR_WAS_PRESENT=0
AUDIT_ACCESS_INSTALLED=0
BUILD_UID=""
BUILD_ACCOUNT_ACTIVE=0
BUILT_PACKAGE_VERSION=""
PRINT_CODEX_SETUP=0
CODEX_SETUP_URL=""
CODEX_SETUP_NAME=""
REFRESH_NETWORK=0
RUN_AS_INSTALLER=0
ENABLE_UNRESTRICTED=0
EXISTING_INSTALLER_MODE=0
INSTALLER_UID=""
INSTALLER_GID=""
INSTALLER_HOME=""
CONFIG_BACKUP=""
INSTALL_SUCCEEDED=0
LEGACY_MIGRATION=0
LEGACY_WAS_ACTIVE=0
LEGACY_WAS_ENABLED=0
LEGACY_UNIT_BACKUP=""
LEGACY_CONFIG_BACKUP=""
LEGACY_CURRENT_TARGET=""
LEGACY_RUNTIME_TARGET=""
LEGACY_ROLLBACK_DONE=0
LEGACY_APP_PRESENT=0
LEGACY_CONFIG_PRESENT=0
LEGACY_STATE_PRESENT=0
SELINUX_ACTIVE=0

log() {
  printf '[CommandBridge] %s\n' "$*"
}

usage() {
  printf '%s\n' \
    'Usage: sudo bash scripts/linux-systemd/install.sh [options]' \
    '' \
    'Options:' \
    '  --print-codex-setup       Print Codex setup, using the listener IP when no URL is given.' \
    '                            The block contains the bearer token.' \
    '  --codex-url URL           Use this private HTTPS MCP URL in the setup block.' \
    '                            The URL must end in /mcp. Implies --print-codex-setup.' \
    '  --codex-name NAME         Use this Codex client connection name instead of cb_<hostname>.' \
    '                            Lowercase letters, digits and underscores; implies setup output.' \
    '  --run-as-installer        Run the Linux service as the original sudo login account.' \
    "                            Uses file Audit and the account's existing sudo policy." \
    '  --unrestricted            With --run-as-installer, allow free shell commands.' \
    '  -h, --help                Show this help and exit.'
}

fail() {
  printf '[CommandBridge] ERROR: %s\n' "$*" >&2
  if [[ "${ACTIVATION_STARTED}" == "1" && "${ROLLBACK_IN_PROGRESS}" == "0" ]]; then
    rollback_activation || true
  fi
  exit 1
}

parse_arguments() {
  while (( $# > 0 )); do
    case "$1" in
      --print-codex-setup)
        PRINT_CODEX_SETUP=1
        ;;
      --refresh-network)
        REFRESH_NETWORK=1
        PRINT_CODEX_SETUP=1
        ;;
      --run-as-installer)
        RUN_AS_INSTALLER=1
        ;;
      --unrestricted)
        ENABLE_UNRESTRICTED=1
        ;;
      --codex-url)
        (( $# >= 2 )) || fail "--codex-url requires a URL."
        CODEX_SETUP_URL=$2
        PRINT_CODEX_SETUP=1
        shift
        ;;
      --codex-url=*)
        CODEX_SETUP_URL=${1#*=}
        [[ -n "${CODEX_SETUP_URL}" ]] || fail "--codex-url requires a URL."
        PRINT_CODEX_SETUP=1
        ;;
      --codex-name)
        (( $# >= 2 )) || fail "--codex-name requires a name."
        CODEX_SETUP_NAME=$2
        validate_codex_name "${CODEX_SETUP_NAME}"
        PRINT_CODEX_SETUP=1
        shift
        ;;
      --codex-name=*)
        CODEX_SETUP_NAME=${1#*=}
        validate_codex_name "${CODEX_SETUP_NAME}"
        PRINT_CODEX_SETUP=1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done
}

validate_codex_name() {
  [[ "$1" =~ ^[a-z][a-z0-9_]{0,63}$ ]] || \
    fail "--codex-name must be 1-64 characters: start with a lowercase letter, then use lowercase letters, digits or underscores."
}

codex_connection_name() {
  local host_name normalized
  if [[ -n "${CODEX_SETUP_NAME}" ]]; then
    printf '%s\n' "${CODEX_SETUP_NAME}"
    return
  fi
  host_name=$(hostname 2>/dev/null || uname -n)
  normalized=$(printf '%s' "${host_name}" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')
  [[ -n "${normalized}" ]] || normalized=host
  printf 'cb_%s\n' "${normalized:0:61}"
}

select_service_identity() {
  local account_entry account_name account_uid account_gid account_home
  [[ "${ENABLE_UNRESTRICTED}" == 0 || "${RUN_AS_INSTALLER}" == 1 ]] || \
    fail "--unrestricted requires --run-as-installer."
  [[ "${RUN_AS_INSTALLER}" == 1 ]] || return 0
  [[ -n "${SUDO_USER:-}" && -n "${SUDO_UID:-}" ]] || \
    fail "--run-as-installer requires sudo from a login account; direct root execution has no installer identity."
  [[ "${SUDO_UID}" =~ ^[0-9]+$ && "${SUDO_UID}" != 0 ]] || \
    fail "--run-as-installer requires a non-root sudo login account."
  account_entry=$(getent passwd "${SUDO_USER}") || fail "The original sudo account cannot be resolved."
  IFS=: read -r account_name _ account_uid account_gid _ account_home _ <<< "${account_entry}"
  [[ "${account_name}" == "${SUDO_USER}" && "${account_uid}" == "${SUDO_UID}" ]] || \
    fail "The original sudo account no longer matches SUDO_UID."
  [[ "${account_gid}" =~ ^[0-9]+$ && "${account_uid}" =~ ^[0-9]+$ ]] || \
    fail "The original sudo account has invalid numeric IDs."
  [[ "${account_home}" == /* && -d "${account_home}" ]] || \
    fail "The original sudo account must have an existing absolute home directory."
  INSTALLER_UID=${account_uid}
  INSTALLER_GID=${account_gid}
  INSTALLER_HOME=$(readlink -f -- "${account_home}")
  [[ "${INSTALLER_HOME}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
    fail "The installer account home path cannot be stored safely in the service configuration."
}

validate_codex_setup_url() {
  local url=$1

  [[ "${url}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~:@%+-]+)*/mcp/?$ ]] || \
    fail "--codex-url must be a private HTTPS URL ending in /mcp, without credentials, a query, or a fragment."
}

collect_codex_setup_url() {
  if [[ -n "${CODEX_SETUP_URL}" ]]; then
    validate_codex_setup_url "${CODEX_SETUP_URL}"
  fi
}

is_private_ipv4() {
  local address=$1 a b c d
  [[ "${address}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r a b c d <<< "${address}"
  a=$((10#$a)); b=$((10#$b)); c=$((10#$c)); d=$((10#$d))
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  (( a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127) ))
}

detect_private_ipv4() {
  local address interface candidates=""
  if command -v ip >/dev/null 2>&1; then
    interface=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev") {print $(i+1); exit}}')
    if [[ -n "${interface}" ]]; then
      candidates=$(ip -4 -o addr show dev "${interface}" scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}')
    fi
    candidates+=$'\n'$(ip -4 -o addr show up scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}')
  elif command -v hostname >/dev/null 2>&1; then
    candidates=$(hostname -I 2>/dev/null || true)
  fi
  for address in ${candidates}; do
    if is_private_ipv4 "${address}"; then
      printf '%s\n' "${address}"
      return
    fi
  done
  printf '127.0.0.1\n'
}

default_http_host() {
  if [[ -n "${CODEX_SETUP_URL}" ]]; then
    printf '127.0.0.1\n'
  else
    detect_private_ipv4
  fi
}

automatic_codex_url() {
  local host port
  host=$(read_config_value COMMAND_BRIDGE_HTTP_HOST)
  port=$(read_config_value COMMAND_BRIDGE_HTTP_PORT)
  case "${host}" in
    0.0.0.0) host=$(detect_private_ipv4) ;;
    ::) host='[::1]' ;;
    *:*) host="[${host}]" ;;
  esac
  printf 'http://%s:%s/mcp\n' "${host}" "${port}"
}

cleanup() {
  if [[ "${INSTALL_SUCCEEDED}" == 0 && "${LEGACY_ROLLBACK_DONE}" == 0 ]]; then
    if [[ "${LEGACY_MIGRATION}" == 1 && -n "${LEGACY_CONFIG_BACKUP}" && -f "${LEGACY_CONFIG_BACKUP}" ]]; then
      install -m 0600 "${LEGACY_CONFIG_BACKUP}" "${CONFIG_FILE}"
    elif [[ -n "${CONFIG_BACKUP}" && -f "${CONFIG_BACKUP}" ]]; then
      install -m 0600 "${CONFIG_BACKUP}" "${CONFIG_FILE}"
    fi
    if [[ -n "${CONFIG_BACKUP}" || -n "${LEGACY_CONFIG_BACKUP}" ]]; then
      restore_selinux_path "${CONFIG_FILE}" || log "WARNING: Restored configuration SELinux label could not be verified."
    fi
  fi
  cleanup_build_account || true
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
    case "${TEMP_DIR}" in
      /tmp/command-bridge-install.*)
        rm -rf -- "${TEMP_DIR}"
        ;;
    esac
  fi
}

create_build_account() {
  local build_home=$1
  local nologin_shell

  getent passwd "${BUILD_USER}" >/dev/null && fail "Temporary build account already exists: ${BUILD_USER}"
  getent group "${BUILD_GROUP}" >/dev/null && fail "Temporary build group already exists: ${BUILD_GROUP}"

  nologin_shell=$(command -v nologin || true)
  [[ -n "${nologin_shell}" ]] || nologin_shell=/bin/false

  groupadd --system "${BUILD_GROUP}"
  BUILD_ACCOUNT_ACTIVE=1
  useradd --system \
    --gid "${BUILD_GROUP}" \
    --home-dir "${build_home}" \
    --shell "${nologin_shell}" \
    --no-create-home \
    "${BUILD_USER}"
  BUILD_UID=$(id -u "${BUILD_USER}")
  [[ -n "${BUILD_UID}" && "${BUILD_UID}" != "0" ]] || fail "Invalid temporary build UID."
}

terminate_build_processes() {
  local attempt

  [[ "${BUILD_ACCOUNT_ACTIVE}" == "1" && -n "${BUILD_UID}" ]] || return
  pkill -KILL -u "${BUILD_UID}" >/dev/null 2>&1 || true
  for (( attempt = 1; attempt <= 10; attempt++ )); do
    if ! pgrep -u "${BUILD_UID}" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  return 1
}

cleanup_build_account() {
  local cleanup_failed=0

  [[ "${BUILD_ACCOUNT_ACTIVE}" == "1" ]] || return
  terminate_build_processes || cleanup_failed=1
  if id -u "${BUILD_USER}" >/dev/null 2>&1; then
    userdel "${BUILD_USER}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if getent group "${BUILD_GROUP}" >/dev/null 2>&1; then
    groupdel "${BUILD_GROUP}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  [[ "${cleanup_failed}" == "0" ]] || return 1
  BUILD_ACCOUNT_ACTIVE=0
  BUILD_UID=""
}

on_error() {
  local exit_code=$?
  trap - ERR
  printf '[CommandBridge] Installation stopped near line %s (exit %s).\n' \
    "${BASH_LINENO[0]:-unknown}" "${exit_code}" >&2
  if [[ "${ACTIVATION_STARTED}" == "1" && "${ROLLBACK_IN_PROGRESS}" == "0" ]]; then
    rollback_activation || true
  fi
  exit "${exit_code}"
}

trap cleanup EXIT
trap on_error ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

detect_selinux() {
  local mode
  SELINUX_ACTIVE=0
  if ! command -v getenforce >/dev/null 2>&1; then
    [[ ! -e /sys/fs/selinux/enforce ]] || fail "SELinux is enabled but getenforce is missing; install policycoreutils and libselinux-utils."
    return 0
  fi
  mode=$(getenforce) || fail "Could not determine SELinux mode."
  case "${mode}" in
    Disabled) return 0 ;;
    Enforcing|Permissive) SELINUX_ACTIVE=1 ;;
    *) fail "Unexpected SELinux mode; refusing to activate the service." ;;
  esac
  require_command restorecon
  require_command matchpathcon
  require_command find
  log "SELinux ${mode}: deployment labels will be restored and verified against host policy."
}

# Return failures instead of exiting: rollback must finish restoring files even
# if the host's labeling tools fail. Never force a type or modify host policy.
restore_selinux_path() {
  local path=$1 recursive=${2:-0}
  [[ "${SELINUX_ACTIVE}" == 1 ]] || return 0
  [[ -e "${path}" || -L "${path}" ]] || return 0
  if [[ "${recursive}" == 1 ]]; then
    [[ -d "${path}" && ! -L "${path}" ]] || { log "ERROR: Refusing recursive SELinux repair of a non-directory: ${path}" >&2; return 1; }
    # Keep traversal in find: Oracle Linux 8 restorecon does not support -x.
    # Physical traversal does not follow release symlinks or cross mount points.
    find -P "${path}" -xdev -exec restorecon {} + || { log "ERROR: SELinux label restore failed: ${path}" >&2; return 1; }
    find -P "${path}" -xdev -exec matchpathcon -V {} + >/dev/null || { log "ERROR: SELinux label verification failed: ${path}" >&2; return 1; }
  else
    restorecon "${path}" || { log "ERROR: SELinux label restore failed: ${path}" >&2; return 1; }
    matchpathcon -V "${path}" >/dev/null || { log "ERROR: SELinux label verification failed: ${path}" >&2; return 1; }
  fi
}

restore_selinux_layout() {
  local app=$1 config=$2 state=$3 unit=$4 reader=$5 sudoers=$6 path failed=0
  [[ "${SELINUX_ACTIVE}" == 1 ]] || return 0
  restore_selinux_path "${app}" 1 || failed=1
  # Only managed files/directories: never recursively relabel user work data or
  # administrator-selected policy paths outside the installation.
  for path in "${config}" "${config}/command-bridge.env" "${config}/policy.json" \
      "${state}" "${state}/work" "${SERVICE_HOME}" "${unit}" \
      "${reader}" "${reader}/audit-reader" "${sudoers}"; do
    restore_selinux_path "${path}" || failed=1
  done
  return "${failed}"
}

restore_current_selinux_layout() {
  restore_selinux_layout "${INSTALL_ROOT}" "${CONFIG_DIR}" "${STATE_DIR}" \
    "${UNIT_FILE}" "${AUDIT_READER_DIR}" "${AUDIT_SUDOERS_FILE}" || return 1
  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then
    restore_selinux_path "${INSTALLER_STATE_DIR}" || return 1
  fi
}

report_execution_context() {
  local node
  node=$(readlink -f "${RUNTIME_LINK}/bin/node") || return 0
  log "Service execution diagnostics (no configuration contents):" >&2
  ls -ldZ -- "${INSTALL_ROOT}" "${RUNTIME_DIR}" "${node}" >&2 || true
  if command -v findmnt >/dev/null 2>&1; then
    findmnt -T "${node}" -o TARGET,FSTYPE >&2 || true
    case ",$(findmnt -n -T "${node}" -o OPTIONS)," in
      *,noexec,*) log "Runtime mount has noexec enabled." >&2 ;;
    esac
  fi
}

require_root_systemd_linux() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this installer as root, for example: sudo bash scripts/linux-systemd/install.sh"
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer supports Linux only."

  require_command systemctl
  [[ -x /usr/bin/sudo ]] || fail "Expected sudo at /usr/bin/sudo."
  if [[ "${RUN_AS_INSTALLER}" == 0 ]]; then
    require_command visudo
    [[ -x /usr/bin/journalctl ]] || \
      fail "Expected journalctl at /usr/bin/journalctl for the fixed audit reader."
  fi
  [[ -d /run/systemd/system ]] || fail "systemd is not running as PID 1 on this host."

  if ldd --version 2>&1 | grep -qi musl; then
    fail "The bundled Node.js runtime requires glibc; musl/Alpine is not supported."
  fi
}

assert_new_installation_paths() {
  local path
  for path in "${INSTALL_ROOT}" "${CONFIG_DIR}" "${STATE_DIR}" "${AUDIT_READER_DIR}"; do
    if [[ -e "${path}" || -L "${path}" ]]; then
      [[ -d "${path}" && ! -L "${path}" ]] || fail "Installation path is not a regular directory: ${path}"
    fi
  done
  if [[ -e "${CONFIG_FILE}" || -L "${CONFIG_FILE}" ]]; then
    [[ -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]] || fail "Configuration is not a regular file."
  fi
  if [[ -e "${UNIT_FILE}" || -L "${UNIT_FILE}" ]]; then
    [[ -f "${UNIT_FILE}" && ! -L "${UNIT_FILE}" ]] || fail "Service unit is not a regular file."
    grep -Fxq "ExecStart=${RUNTIME_LINK}/bin/node ${CURRENT_LINK}/dist/index.js" "${UNIT_FILE}" ||
      fail "An unrelated ${SERVICE_NAME}.service already exists; it was not replaced."
    if grep -Fxq "User=${SERVICE_USER}" "${UNIT_FILE}"; then
      : # A dedicated-account installation may switch to the opt-in account.
    elif grep -Eq '^User=[0-9]+$' "${UNIT_FILE}" &&
         grep -Fxq "Environment=XDG_DATA_HOME=${INSTALLER_STATE_DIR}" "${UNIT_FILE}"; then
      EXISTING_INSTALLER_MODE=1
      [[ "${RUN_AS_INSTALLER}" == 1 ]] || \
        fail "This service runs as an installer account; reinstall with --run-as-installer."
      grep -Fxq "User=${INSTALLER_UID}" "${UNIT_FILE}" || \
        fail "The existing service belongs to a different installer account."
    else
      fail "Service unit has an unexpected account."
    fi
  fi
  if [[ "${RUN_AS_INSTALLER}" == 1 && ( -e "${INSTALLER_STATE_DIR}" || -L "${INSTALLER_STATE_DIR}" ) ]]; then
    [[ -d "${INSTALLER_STATE_DIR}" && ! -L "${INSTALLER_STATE_DIR}" ]] || \
      fail "Installer account state path is not a regular directory."
    [[ "$(stat -c '%u' "${INSTALLER_STATE_DIR}")" == "${INSTALLER_UID}" ]] || \
      fail "Installer account state directory belongs to another account."
  fi
}

detect_node_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)
      printf 'x64\n'
      ;;
    aarch64 | arm64)
      printf 'arm64\n'
      ;;
    *)
      fail "Unsupported CPU architecture: $(uname -m). Supported: x86_64 and arm64."
      ;;
  esac
}

download_https() {
  local url=$1
  local destination=$2
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    "${url}" --output "${destination}"
}

find_local_source() {
  local script_path=${BASH_SOURCE[0]:-}
  local script_dir candidate

  [[ -n "${script_path}" && -f "${script_path}" ]] || return 1
  script_dir=$(cd "$(dirname "${script_path}")" && pwd -P)

  for candidate in "${script_dir}" "${script_dir}/../.."; do
    candidate=$(cd "${candidate}" 2>/dev/null && pwd -P) || continue
    if [[ -f "${candidate}/package.json" && -d "${candidate}/src" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  return 1
}

prepare_node_runtime() {
  local node_arch=$1
  local archive_name="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
  local archive_path="${TEMP_DIR}/${archive_name}"
  local checksums_path="${TEMP_DIR}/SHASUMS256.txt"
  local match_count expected_hash actual_hash node_version_output

  log "Downloading private Node.js v${NODE_VERSION} runtime (${node_arch})..."
  download_https "${NODE_RELEASE_BASE}/SHASUMS256.txt" "${checksums_path}"
  download_https "${NODE_RELEASE_BASE}/${archive_name}" "${archive_path}"

  match_count=$(awk -v file="${archive_name}" '$2 == file { count++ } END { print count + 0 }' "${checksums_path}")
  [[ "${match_count}" == "1" ]] || fail "Node.js checksum manifest did not contain exactly one ${archive_name} entry."

  expected_hash=$(awk -v file="${archive_name}" '$2 == file { print $1 }' "${checksums_path}")
  actual_hash=$(sha256sum "${archive_path}" | awk '{ print $1 }')
  [[ "${actual_hash}" == "${expected_hash}" ]] || fail "Node.js SHA-256 verification failed."

  install -d -m 0755 "${TEMP_DIR}/node-runtime"
  tar -xzf "${archive_path}" -C "${TEMP_DIR}/node-runtime" --strip-components=1

  if ! node_version_output=$("${TEMP_DIR}/node-runtime/bin/node" --version 2>&1); then
    fail "The bundled Node.js runtime cannot run on this host. Node.js 24 requires Linux kernel 4.18+, glibc 2.28+, and libstdc++ 6.0.25+. Details: ${node_version_output}"
  fi
  [[ "${node_version_output}" == "v${NODE_VERSION}" ]] || \
    fail "The extracted Node.js runtime failed its version check."
}

prepare_source() {
  local source_dir="${TEMP_DIR}/source"
  local local_source=""
  local unit_hash installer_unit_hash audit_reader_hash

  install -d -m 0755 "${source_dir}"

  if local_source=$(find_local_source); then
    if [[ -f "${local_source}/.command-bridge-source-sha" ]]; then
      SOURCE_REF=$(cat "${local_source}/.command-bridge-source-sha")
    else
      SOURCE_REF=$(git -C "${local_source}" rev-parse HEAD)
      [[ -z "$(git -C "${local_source}" status --porcelain --untracked-files=normal)" ]] || fail "Commit local source changes before installation so release identity is unambiguous."
    fi
    [[ "${SOURCE_REF}" =~ ^[a-f0-9]{40}$ ]] || fail "A full source commit SHA is required."
    log "Using local CommandBridge source from ${local_source}."
    tar -C "${local_source}" \
      --exclude=.git \
      --exclude=.codegraph \
      --exclude=node_modules \
      --exclude=dist \
      --exclude=.env \
      -cf - . | tar -C "${source_dir}" -xf -
  else
    fail "Use scripts/bootstrap.sh to download a CI-verified source snapshot."
  fi

  [[ -f "${source_dir}/package.json" ]] || fail "Downloaded source is missing package.json."
  [[ -f "${source_dir}/package-lock.json" ]] || fail "Downloaded source is missing package-lock.json."
  [[ -f "${source_dir}/tsconfig.json" ]] || fail "Downloaded source is missing tsconfig.json."
  [[ -f "${source_dir}/src/index.ts" ]] || fail "Downloaded source is missing src/index.ts."
  [[ -f "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" ]] || \
    fail "Downloaded source is missing the systemd unit."
  [[ -f "${source_dir}/packaging/systemd/${SERVICE_NAME}-installer.service" ]] || \
    fail "Downloaded source is missing the installer-account systemd unit."
  [[ -f "${source_dir}/packaging/linux/audit-reader" ]] || \
    fail "Downloaded source is missing the audit reader."

  unit_hash=$(sha256sum "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" | awk '{ print $1 }')
  [[ "${unit_hash}" == "${SYSTEMD_UNIT_SHA256}" ]] || \
    fail "The systemd unit does not match the installer-pinned SHA-256 digest."
  installer_unit_hash=$(sha256sum "${source_dir}/packaging/systemd/${SERVICE_NAME}-installer.service" | awk '{ print $1 }')
  [[ "${installer_unit_hash}" == "${INSTALLER_UNIT_SHA256}" ]] || \
    fail "The installer-account systemd unit does not match the installer-pinned SHA-256 digest."
  audit_reader_hash=$(sha256sum "${source_dir}/packaging/linux/audit-reader" | awk '{ print $1 }')
  [[ "${audit_reader_hash}" == "${AUDIT_READER_SHA256}" ]] || \
    fail "The audit reader does not match the installer-pinned SHA-256 digest."

  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then
    sed -e "s/__INSTALLER_UID__/${INSTALLER_UID}/g" \
        -e "s/__INSTALLER_GID__/${INSTALLER_GID}/g" \
      "${source_dir}/packaging/systemd/${SERVICE_NAME}-installer.service" > "${TEMP_DIR}/${SERVICE_NAME}.service"
    grep -Fxq "User=${INSTALLER_UID}" "${TEMP_DIR}/${SERVICE_NAME}.service" || \
      fail "Installer-account systemd unit rendering failed."
  else
    install -m 0600 \
      "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" \
      "${TEMP_DIR}/${SERVICE_NAME}.service"
  fi
  install -m 0755 \
    "${source_dir}/packaging/linux/audit-reader" \
    "${TEMP_DIR}/audit-reader"
}

build_source() {
  local source_dir="${TEMP_DIR}/source"
  local node_root="${TEMP_DIR}/node-runtime"
  local build_home="${TEMP_DIR}/build-home"
  local package_name package_version

  package_name=$("${node_root}/bin/node" -p "require('${source_dir}/package.json').name")
  package_version=$("${node_root}/bin/node" -p "require('${source_dir}/package.json').version")
  [[ "${package_name}" == "command-bridge-mcp-server" ]] || fail "Unexpected npm package: ${package_name}"
  [[ "${package_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid source package version."
  if [[ -f "${source_dir}/.command-bridge-source-version" ]]; then
    [[ "${package_version}" == "$(cat "${source_dir}/.command-bridge-source-version")" ]] || fail "Source version does not match the verified channel."
  fi
  local original_version=${package_version}

  create_build_account "${build_home}"
  install -d -m 0700 -o "${BUILD_USER}" -g "${BUILD_GROUP}" "${build_home}"
  # npm rejects using the same path for both config layers. Keep distinct,
  # empty files so neither operation loads the host's user/global npm settings.
  install -m 0600 -o "${BUILD_USER}" -g "${BUILD_GROUP}" /dev/null "${build_home}/user.npmrc"
  install -m 0600 -o "${BUILD_USER}" -g "${BUILD_GROUP}" /dev/null "${build_home}/global.npmrc"
  chown -R "${BUILD_USER}:${BUILD_GROUP}" "${source_dir}"

  log "Installing locked npm dependencies without lifecycle scripts..."
  (
    cd "${source_dir}"
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      npm_config_cache="${build_home}/.npm" \
      npm_config_userconfig="${build_home}/user.npmrc" \
      npm_config_globalconfig="${build_home}/global.npmrc" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/npm" ci --ignore-scripts --no-audit --no-fund

    log "Building and testing CommandBridge MCP as an unprivileged user..."
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/node" "${source_dir}/scripts/build.mjs"
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/node" "${source_dir}/scripts/test.mjs"

    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      npm_config_cache="${build_home}/.npm" \
      npm_config_userconfig="${build_home}/user.npmrc" \
      npm_config_globalconfig="${build_home}/global.npmrc" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/npm" prune --omit=dev --ignore-scripts --no-audit --no-fund
  )

  terminate_build_processes || fail "Temporary build account still has running processes."
  chown -R root:root "${source_dir}"
  chmod -R go-w "${source_dir}"

  package_name=$("${node_root}/bin/node" -p "require('${source_dir}/package.json').name")
  package_version=$("${node_root}/bin/node" -p "require('${source_dir}/package.json').version")
  [[ "${package_name}" == "command-bridge-mcp-server" ]] || fail "Built package name changed unexpectedly."
  [[ "${package_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Built package version is not path-safe."
  [[ "${package_version}" == "${original_version}" ]] || fail "Built package version changed unexpectedly."
  [[ -f "${source_dir}/dist/index.js" && ! -L "${source_dir}/dist/index.js" ]] || \
    fail "Build completed without a regular dist/index.js file."
  [[ -d "${source_dir}/node_modules/@modelcontextprotocol/sdk" && \
    ! -L "${source_dir}/node_modules/@modelcontextprotocol/sdk" ]] || \
    fail "Production dependencies are incomplete."

  BUILT_PACKAGE_VERSION="${package_version}"
  cleanup_build_account || fail "Could not remove the temporary build account."
}

ensure_service_account() {
  local nologin_shell
  nologin_shell=$(command -v nologin || true)
  [[ -n "${nologin_shell}" ]] || nologin_shell=/bin/false

  if ! getent group "${SERVICE_GROUP}" >/dev/null; then
    groupadd --system "${SERVICE_GROUP}"
  fi

  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system \
      --gid "${SERVICE_GROUP}" \
      --home-dir "${SERVICE_HOME}" \
      --shell "${nologin_shell}" \
      --no-create-home \
      "${SERVICE_USER}"
  fi

  [[ "$(id -u "${SERVICE_USER}")" != "0" ]] || fail "Refusing to use a UID 0 service account."
  [[ "$(id -gn "${SERVICE_USER}")" == "${SERVICE_GROUP}" ]] || \
    fail "Existing ${SERVICE_USER} account has an unexpected primary group."
  [[ "$(id -nG "${SERVICE_USER}")" == "${SERVICE_GROUP}" ]] || \
    fail "Existing ${SERVICE_USER} account has extra groups; remove privileged memberships first."

  install -d -m 0555 -o root -g root "${SERVICE_HOME}"
  install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${STATE_DIR}"
  install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${WORK_DIR_PATH}"
}

ensure_installer_state() {
  [[ "${RUN_AS_INSTALLER}" == 1 ]] || return 0
  # /var/lib is root-owned. Do not run privileged install/chown recursively
  # inside this user-writable directory; Node creates its own Audit children.
  install -d -m 0700 -o "${INSTALLER_UID}" -g "${INSTALLER_GID}" "${INSTALLER_STATE_DIR}"
  restore_current_selinux_layout || fail "Could not prepare installer-account state labels."
}

check_legacy_tree() {
  local old=$1 new=$2
  if [[ -L "${old}" ]]; then
    [[ "$(readlink "${old}")" == "${new}" && -d "${new}" && ! -L "${new}" ]] || \
      fail "Legacy path is not the expected CommandBridge alias: ${old}"
  elif [[ -e "${old}" ]]; then
    [[ -d "${old}" && ! -e "${new}" && ! -L "${new}" ]] || \
      fail "Both old and new installation paths exist; resolve the conflict before upgrading: ${old}"
    if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "${old}"; then
      fail "Refusing to migrate a mounted path: ${old}"
    fi
  fi
}

move_legacy_tree() {
  local old=$1 new=$2
  if [[ -d "${old}" && ! -L "${old}" ]]; then
    mv -T -- "${old}" "${new}"
    ln -s "${new}" "${old}"
  fi
}

restore_legacy_tree() {
  local old=$1 new=$2
  if [[ -L "${old}" && "$(readlink "${old}")" == "${new}" ]]; then
    unlink "${old}"
  fi
  if [[ ! -e "${old}" && ! -L "${old}" && -d "${new}" ]]; then
    mv -T -- "${new}" "${old}"
  fi
}

migrate_legacy_layout() {
  local old new
  if [[ ! -e "${LEGACY_UNIT_FILE}" && ! -L "${LEGACY_UNIT_FILE}" && \
        ( ! -e "${LEGACY_INSTALL_ROOT}" || -L "${LEGACY_INSTALL_ROOT}" ) && \
        ( ! -e "${LEGACY_CONFIG_DIR}" || -L "${LEGACY_CONFIG_DIR}" ) && \
        ( ! -e "${LEGACY_STATE_DIR}" || -L "${LEGACY_STATE_DIR}" ) ]]; then
    check_legacy_tree "${LEGACY_INSTALL_ROOT}" "${INSTALL_ROOT}"
    check_legacy_tree "${LEGACY_CONFIG_DIR}" "${CONFIG_DIR}"
    check_legacy_tree "${LEGACY_STATE_DIR}" "${STATE_DIR}"
    return
  fi

  [[ ! -L "${LEGACY_UNIT_FILE}" ]] || fail "Legacy service unit must be a regular file."
  if [[ -e "${LEGACY_UNIT_FILE}" ]]; then
    [[ -f "${LEGACY_UNIT_FILE}" ]] || fail "Legacy service unit is not a regular file."
    [[ -d "${LEGACY_INSTALL_ROOT}" && -f "${LEGACY_CONFIG_DIR}/command-bridge.env" && \
       -d "${LEGACY_STATE_DIR}/work" ]] || fail "Legacy service files are incomplete; the existing service was not changed."
    [[ ! -e "${UNIT_FILE}" && ! -L "${UNIT_FILE}" ]] || \
      fail "Both old and new service units exist; inspect them before upgrading."
    [[ ! -L "${LEGACY_CONFIG_DIR}/command-bridge.env" ]] || fail "Legacy configuration is a symbolic link."
    for old in "${LEGACY_AUDIT_SUDOERS_FILE}" "${LEGACY_AUDIT_READER_DIR}/audit-reader"; do
      if [[ -e "${old}" || -L "${old}" ]]; then
        [[ -f "${old}" && ! -L "${old}" ]] || fail "Legacy audit access file is not regular: ${old}"
      fi
    done
    old=$(systemctl show --property=FragmentPath --value "${LEGACY_SERVICE_NAME}.service")
    [[ "${old}" == "${LEGACY_UNIT_FILE}" ]] || fail "Legacy service unit path is unexpected."
    LEGACY_CURRENT_TARGET=$(readlink "${LEGACY_INSTALL_ROOT}/current")
    LEGACY_RUNTIME_TARGET=$(readlink "${LEGACY_INSTALL_ROOT}/runtime/current")
    [[ "${LEGACY_CURRENT_TARGET}" == "${LEGACY_INSTALL_ROOT}/releases/"* &&
       "${LEGACY_RUNTIME_TARGET}" == "${LEGACY_INSTALL_ROOT}/runtime/"* ]] ||
      fail "Legacy release links are unexpected; the existing service was not changed."
  fi
  check_legacy_tree "${LEGACY_INSTALL_ROOT}" "${INSTALL_ROOT}"
  check_legacy_tree "${LEGACY_CONFIG_DIR}" "${CONFIG_DIR}"
  check_legacy_tree "${LEGACY_STATE_DIR}" "${STATE_DIR}"

  if [[ -e "${LEGACY_INSTALL_ROOT}" || -L "${LEGACY_INSTALL_ROOT}" ]]; then LEGACY_APP_PRESENT=1; fi
  if [[ -e "${LEGACY_CONFIG_DIR}" || -L "${LEGACY_CONFIG_DIR}" ]]; then LEGACY_CONFIG_PRESENT=1; fi
  if [[ -e "${LEGACY_STATE_DIR}" || -L "${LEGACY_STATE_DIR}" ]]; then LEGACY_STATE_PRESENT=1; fi

  LEGACY_MIGRATION=1
  ACTIVATION_STARTED=1
  if [[ -f "${LEGACY_UNIT_FILE}" ]]; then
    LEGACY_UNIT_BACKUP="${TEMP_DIR}/legacy-unit.service"
    install -m 0600 "${LEGACY_UNIT_FILE}" "${LEGACY_UNIT_BACKUP}"
    if systemctl is-enabled --quiet "${LEGACY_SERVICE_NAME}.service"; then LEGACY_WAS_ENABLED=1; fi
    if systemctl is-active --quiet "${LEGACY_SERVICE_NAME}.service"; then
      LEGACY_WAS_ACTIVE=1
      systemctl stop "${LEGACY_SERVICE_NAME}.service"
    fi
  fi
  log "Migrating the Linux service and paths to ${SERVICE_NAME}; preserving legacy path aliases."
  move_legacy_tree "${LEGACY_INSTALL_ROOT}" "${INSTALL_ROOT}"
  move_legacy_tree "${LEGACY_CONFIG_DIR}" "${CONFIG_DIR}"
  move_legacy_tree "${LEGACY_STATE_DIR}" "${STATE_DIR}"

  if [[ -f "${CONFIG_FILE}" ]]; then
    LEGACY_CONFIG_BACKUP="${TEMP_DIR}/legacy-config.env"
    install -m 0600 "${CONFIG_FILE}" "${LEGACY_CONFIG_BACKUP}"
    awk -v old_config="${LEGACY_CONFIG_DIR}" -v new_config="${CONFIG_DIR}" \
        -v old_state="${LEGACY_STATE_DIR}" -v new_state="${STATE_DIR}" '
      /^COMMAND_BRIDGE_POLICY_FILE=/ { gsub(old_config, new_config) }
      /^COMMAND_BRIDGE_ALLOWED_ROOTS=/ { gsub(old_state, new_state) }
      { print }
    ' "${CONFIG_FILE}" > "${TEMP_DIR}/migrated-config.env"
    install -m 0600 -o root -g root "${TEMP_DIR}/migrated-config.env" "${CONFIG_FILE}"
  fi
}

backup_audit_access() {
  if [[ -e "${AUDIT_READER_DIR}" || -L "${AUDIT_READER_DIR}" ]]; then
    [[ -d "${AUDIT_READER_DIR}" && ! -L "${AUDIT_READER_DIR}" ]] || \
      fail "Audit reader directory is not a regular directory: ${AUDIT_READER_DIR}"
    AUDIT_READER_DIR_WAS_PRESENT=1
  fi

  if [[ -e "${AUDIT_READER_PATH}" || -L "${AUDIT_READER_PATH}" ]]; then
    [[ -f "${AUDIT_READER_PATH}" && ! -L "${AUDIT_READER_PATH}" ]] || \
      fail "Existing audit reader is not a regular file."
    PREVIOUS_AUDIT_READER_BACKUP="${TEMP_DIR}/previous-audit-reader"
    install -m 0600 "${AUDIT_READER_PATH}" "${PREVIOUS_AUDIT_READER_BACKUP}"
    AUDIT_READER_WAS_PRESENT=1
  fi

  if [[ -e "${AUDIT_SUDOERS_FILE}" || -L "${AUDIT_SUDOERS_FILE}" ]]; then
    [[ -f "${AUDIT_SUDOERS_FILE}" && ! -L "${AUDIT_SUDOERS_FILE}" ]] || \
      fail "Existing audit sudoers entry is not a regular file."
    PREVIOUS_AUDIT_SUDOERS_BACKUP="${TEMP_DIR}/previous-audit-reader.sudoers"
    install -m 0600 "${AUDIT_SUDOERS_FILE}" "${PREVIOUS_AUDIT_SUDOERS_BACKUP}"
    AUDIT_SUDOERS_WAS_PRESENT=1
  fi
}

install_audit_access() {
  local sudoers_staging path

  backup_audit_access
  AUDIT_ACCESS_INSTALLED=1
  install -d -m 0755 -o root -g root "${AUDIT_READER_DIR}"
  install -m 0755 -o root -g root "${TEMP_DIR}/audit-reader" "${AUDIT_READER_PATH}"

  sudoers_staging="${TEMP_DIR}/audit-reader.sudoers"
  printf '%s ALL=(root) NOPASSWD: %s ""\n' \
    "${SERVICE_USER}" "${AUDIT_READER_PATH}" > "${sudoers_staging}"
  chmod 0440 "${sudoers_staging}"
  visudo -cf "${sudoers_staging}" >/dev/null
  install -m 0440 -o root -g root "${sudoers_staging}" "${AUDIT_SUDOERS_FILE}"
  visudo -cf "${AUDIT_SUDOERS_FILE}" >/dev/null

  [[ "$(stat -c '%U:%G:%a' "${AUDIT_READER_PATH}")" == "root:root:755" ]] || \
    fail "Audit reader ownership or mode verification failed."
  [[ "$(stat -c '%U:%G:%a' "${AUDIT_SUDOERS_FILE}")" == "root:root:440" ]] || \
    fail "Audit sudoers ownership or mode verification failed."

  for path in "${AUDIT_READER_DIR}" "${AUDIT_READER_PATH}" "${AUDIT_SUDOERS_FILE}"; do
    restore_selinux_path "${path}" || fail "Could not prepare SELinux labels for Audit access."
  done
  runuser -u "${SERVICE_USER}" -- /usr/bin/sudo -n "${AUDIT_READER_PATH}" >/dev/null
}

remove_audit_access_for_installer() {
  [[ "${RUN_AS_INSTALLER}" == 1 ]] || return 0
  backup_audit_access
  AUDIT_ACCESS_INSTALLED=1
  rm -f -- "${AUDIT_SUDOERS_FILE}" "${AUDIT_READER_PATH}"
  if [[ "${AUDIT_READER_DIR_WAS_PRESENT}" == 1 ]]; then
    rmdir "${AUDIT_READER_DIR}" >/dev/null 2>&1 || true
  fi
}

rollback_audit_access() {
  [[ "${AUDIT_ACCESS_INSTALLED}" == "1" ]] || return 0

  if [[ "${AUDIT_READER_DIR_WAS_PRESENT}" == "1" ]]; then
    install -d -m 0755 -o root -g root "${AUDIT_READER_DIR}" || true
  fi

  if [[ "${AUDIT_SUDOERS_WAS_PRESENT}" == "1" && -f "${PREVIOUS_AUDIT_SUDOERS_BACKUP}" ]]; then
    install -m 0440 -o root -g root \
      "${PREVIOUS_AUDIT_SUDOERS_BACKUP}" "${AUDIT_SUDOERS_FILE}" || true
  else
    rm -f -- "${AUDIT_SUDOERS_FILE}" || true
  fi

  if [[ "${AUDIT_READER_WAS_PRESENT}" == "1" && -f "${PREVIOUS_AUDIT_READER_BACKUP}" ]]; then
    install -m 0755 -o root -g root \
      "${PREVIOUS_AUDIT_READER_BACKUP}" "${AUDIT_READER_PATH}" || true
  else
    rm -f -- "${AUDIT_READER_PATH}" || true
  fi

  if [[ "${AUDIT_READER_DIR_WAS_PRESENT}" == "0" ]]; then
    rmdir "${AUDIT_READER_DIR}" >/dev/null 2>&1 || true
  fi
  AUDIT_ACCESS_INSTALLED=0
}

install_runtime_and_release() {
  local node_arch=$1
  local source_dir="${TEMP_DIR}/source"
  local runtime_name="node-v${NODE_VERSION}-linux-${node_arch}"
  local runtime_final="${RUNTIME_DIR}/${runtime_name}"
  local runtime_staging="${RUNTIME_DIR}/.${runtime_name}.new.$$"
  local package_version release_name release_final release_staging path

  package_version=${BUILT_PACKAGE_VERSION}
  [[ -n "${package_version}" ]] || fail "Built package version was not recorded."
  release_name="v${package_version}-${SOURCE_REF}"
  release_final="${RELEASES_DIR}/${release_name}"
  release_staging="${RELEASES_DIR}/.${release_name}.new.$$"

  install -d -m 0755 -o root -g root "${INSTALL_ROOT}" "${RELEASES_DIR}" "${RUNTIME_DIR}"
  for path in "${INSTALL_ROOT}" "${RELEASES_DIR}" "${RUNTIME_DIR}"; do
    restore_selinux_path "${path}" || fail "Could not prepare SELinux deployment directory labels."
  done

  if [[ -e "${runtime_final}" ]]; then
    restore_selinux_path "${runtime_final}" 1 || fail "Could not repair the existing runtime's SELinux labels."
    [[ -x "${runtime_final}/bin/node" ]] || fail "Existing runtime is incomplete: ${runtime_final}"
    [[ "$("${runtime_final}/bin/node" --version)" == "v${NODE_VERSION}" ]] || \
      fail "Existing runtime has an unexpected Node.js version."
  else
    install -d -m 0755 "${runtime_staging}"
    cp -a --no-preserve=context "${TEMP_DIR}/node-runtime/." "${runtime_staging}/"
    chown -R root:root "${runtime_staging}"
    chmod -R go-w "${runtime_staging}"
    mv "${runtime_staging}" "${runtime_final}"
  fi

  if [[ -e "${release_final}" ]]; then
    [[ -f "${release_final}/.command-bridge-release" ]] || \
      fail "Existing release is incomplete: ${release_final}"
  else
    install -d -m 0755 "${release_staging}"
    cp -a --no-preserve=context \
      "${source_dir}/dist" \
      "${source_dir}/node_modules" \
      "${source_dir}/package.json" \
      "${source_dir}/package-lock.json" \
      "${source_dir}/README.md" \
      "${source_dir}/SECURITY.md" \
      "${release_staging}/"
    printf '%s\n' "${SOURCE_REF}" > "${release_staging}/.command-bridge-release"
    install -m 0755 "${source_dir}/scripts/linux-systemd/uninstall.sh" "${release_staging}/uninstall.sh"
    install -d -m 0755 "${release_staging}/scripts"
    install -m 0644 "${source_dir}/scripts/verify-install.mjs" "${release_staging}/scripts/verify-install.mjs"
    printf '{"version":"%s","sourceSha":"%s","runtimeVersion":"%s"}\n' "${package_version}" "${SOURCE_REF}" "${NODE_VERSION}" > "${release_staging}/install-info.json"
    chown -R root:root "${release_staging}"
    chmod -R go-w "${release_staging}"
    mv "${release_staging}" "${release_final}"
  fi

  # Also repair reused runtimes/releases left behind by a failed installation.
  restore_current_selinux_layout || fail "SELinux deployment labels could not be prepared; service activation stopped."

  if [[ -L "${CURRENT_LINK}" ]]; then
    PREVIOUS_RELEASE=$(readlink -f "${CURRENT_LINK}" || true)
  fi
  if [[ -L "${RUNTIME_LINK}" ]]; then
    PREVIOUS_RUNTIME=$(readlink -f "${RUNTIME_LINK}" || true)
  fi
  if [[ -e "${UNIT_FILE}" || -L "${UNIT_FILE}" ]]; then
    [[ -f "${UNIT_FILE}" ]] || fail "Existing systemd unit is not a regular file."
    PREVIOUS_UNIT_BACKUP="${TEMP_DIR}/previous-${SERVICE_NAME}.service"
    install -m 0600 "${UNIT_FILE}" "${PREVIOUS_UNIT_BACKUP}"
    UNIT_WAS_PRESENT=1
  fi

  ACTIVATION_STARTED=1
  ln -sfnT "${runtime_final}" "${RUNTIME_LINK}"
  ln -sfnT "${release_final}" "${CURRENT_LINK}"
  restore_selinux_path "${RUNTIME_LINK}" || fail "Could not label the active runtime link."
  restore_selinux_path "${CURRENT_LINK}" || fail "Could not label the active release link."
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

validate_new_configuration() {
  local token=$1
  local host=$2
  local port=$3
  local allowed_hosts=$4
  local execution_mode=$5

  [[ "${token}" =~ ^[A-Za-z0-9._~-]{32,}$ ]] || \
    fail "COMMAND_BRIDGE_BEARER_TOKEN must contain at least 32 safe characters."
  [[ "${host}" =~ ^[A-Za-z0-9._:%-]+$ ]] || fail "Invalid COMMAND_BRIDGE_HTTP_HOST."
  [[ "${port}" =~ ^[0-9]+$ ]] || fail "COMMAND_BRIDGE_HTTP_PORT must be numeric."
  (( port >= 1 && port <= 65535 )) || fail "COMMAND_BRIDGE_HTTP_PORT must be between 1 and 65535."
  [[ "${execution_mode}" == "allowlist" || "${execution_mode}" == "unrestricted" ]] || \
    fail "COMMAND_BRIDGE_EXECUTION_MODE must be allowlist or unrestricted."

  if [[ "${host}" != "127.0.0.1" && "${host}" != "localhost" && "${host}" != "::1" ]]; then
    [[ -n "${allowed_hosts}" ]] || \
      fail "COMMAND_BRIDGE_ALLOWED_HOSTS is required for a non-loopback HTTP host."
  fi

  local allowed_hosts_pattern='^([A-Za-z0-9.,:_-]|\[|\])*$'
  [[ "${allowed_hosts}" =~ ${allowed_hosts_pattern} ]] || \
    fail "COMMAND_BRIDGE_ALLOWED_HOSTS contains unsupported characters."
}

install_configuration() {
  local token host port allowed_hosts execution_mode audit_backend allowed_roots

  install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${CONFIG_DIR}"
  if [[ ! -e "${CONFIG_DIR}/policy.json" ]]; then
    install -m 0640 -o root -g "${SERVICE_GROUP}" "${TEMP_DIR}/source/packaging/policy.example.json" "${CONFIG_DIR}/policy.json"
  fi

  if [[ -e "${CONFIG_FILE}" ]]; then
    log "Preserving existing configuration and bearer token at ${CONFIG_FILE}."
    chown root:root "${CONFIG_FILE}"
    chmod 0600 "${CONFIG_FILE}"
    if [[ "${REFRESH_NETWORK}" == 1 || "${ENABLE_UNRESTRICTED}" == 1 || ( "${RUN_AS_INSTALLER}" == 1 && "${EXISTING_INSTALLER_MODE}" == 0 ) ]]; then
      CONFIG_BACKUP="${TEMP_DIR}/previous-config.env"
      cp -p "${CONFIG_FILE}" "${CONFIG_BACKUP}"
      if [[ "${REFRESH_NETWORK}" == 1 ]]; then host=$(detect_private_ipv4); fi
      if [[ "${RUN_AS_INSTALLER}" == 1 && "${EXISTING_INSTALLER_MODE}" == 0 ]]; then
        allowed_roots="${INSTALLER_HOME}:/"
      fi
      awk -v host="${host:-}" -v roots="${allowed_roots:-}" -v unrestricted="${ENABLE_UNRESTRICTED}" '
        /^COMMAND_BRIDGE_HTTP_HOST=/ && host != "" { print "COMMAND_BRIDGE_HTTP_HOST=" host; next }
        /^COMMAND_BRIDGE_ALLOWED_HOSTS=/ && host != "" { print "COMMAND_BRIDGE_ALLOWED_HOSTS=" host; next }
        /^COMMAND_BRIDGE_AUDIT_BACKEND=/ && roots != "" { print "COMMAND_BRIDGE_AUDIT_BACKEND=file"; audit_seen=1; next }
        /^COMMAND_BRIDGE_ALLOWED_ROOTS=/ && roots != "" { print "COMMAND_BRIDGE_ALLOWED_ROOTS=" roots; roots_seen=1; next }
        /^COMMAND_BRIDGE_EXECUTION_MODE=/ && unrestricted == "1" { print "COMMAND_BRIDGE_EXECUTION_MODE=unrestricted"; mode_seen=1; next }
        { print }
        END {
          if (roots != "" && !audit_seen) print "COMMAND_BRIDGE_AUDIT_BACKEND=file"
          if (roots != "" && !roots_seen) print "COMMAND_BRIDGE_ALLOWED_ROOTS=" roots
          if (unrestricted == "1" && !mode_seen) print "COMMAND_BRIDGE_EXECUTION_MODE=unrestricted"
        }
      ' "${CONFIG_FILE}" > "${CONFIG_FILE}.new"
      chmod 0600 "${CONFIG_FILE}.new"
      mv "${CONFIG_FILE}.new" "${CONFIG_FILE}"
    fi
    return
  fi

  token=${COMMAND_BRIDGE_BEARER_TOKEN:-$(generate_token)}
  host=${COMMAND_BRIDGE_HTTP_HOST:-$(default_http_host)}
  port=${COMMAND_BRIDGE_HTTP_PORT:-8800}
  allowed_hosts=${COMMAND_BRIDGE_ALLOWED_HOSTS:-}
  if [[ -z "${allowed_hosts}" && "${host}" != "127.0.0.1" && "${host}" != "localhost" && "${host}" != "::1" && "${host}" != "0.0.0.0" && "${host}" != "::" ]]; then
    allowed_hosts=${host}
  fi
  execution_mode=${COMMAND_BRIDGE_EXECUTION_MODE:-allowlist}
  if [[ "${ENABLE_UNRESTRICTED}" == 1 ]]; then execution_mode=unrestricted; fi
  audit_backend=journal
  allowed_roots=${WORK_DIR_PATH}
  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then
    audit_backend=file
    allowed_roots="${INSTALLER_HOME}:/"
  fi
  validate_new_configuration "${token}" "${host}" "${port}" "${allowed_hosts}" "${execution_mode}"

  umask 077
  {
    printf 'COMMAND_BRIDGE_TRANSPORT=http\n'
    printf 'COMMAND_BRIDGE_AUDIT_BACKEND=%s\n' "${audit_backend}"
    printf 'COMMAND_BRIDGE_POLICY_FILE=%s/policy.json\n' "${CONFIG_DIR}"
    printf 'COMMAND_BRIDGE_BEARER_TOKEN=%s\n' "${token}"
    printf 'COMMAND_BRIDGE_HTTP_HOST=%s\n' "${host}"
    printf 'COMMAND_BRIDGE_HTTP_PORT=%s\n' "${port}"
    printf 'COMMAND_BRIDGE_ALLOWED_HOSTS=%s\n' "${allowed_hosts}"
    printf 'COMMAND_BRIDGE_EXECUTION_MODE=%s\n' "${execution_mode}"
    printf 'COMMAND_BRIDGE_ALLOWED_SHELLS=bash\n'
    printf 'COMMAND_BRIDGE_ALLOWED_COMMANDS=uname,hostname,whoami,uptime,date,df,free,ps,pwd\n'
    printf 'COMMAND_BRIDGE_ALLOWED_ROOTS=%s\n' "${allowed_roots}"
    printf 'COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS=15000\n'
    printf 'COMMAND_BRIDGE_MAX_TIMEOUT_MS=60000\n'
    printf 'COMMAND_BRIDGE_MAX_OUTPUT_CHARS=50000\n'
    printf 'COMMAND_BRIDGE_MAX_PARALLEL_COMMANDS=2\n'
    printf 'COMMAND_BRIDGE_PASSTHROUGH_ENV=\n'
  } > "${CONFIG_FILE}"
  chown root:root "${CONFIG_FILE}"
  chmod 0600 "${CONFIG_FILE}"
}

read_config_value() {
  local key=$1
  awk -v key="${key}" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "${CONFIG_FILE}"
}

health_url() {
  local host port
  host=$(read_config_value COMMAND_BRIDGE_HTTP_HOST)
  port=$(read_config_value COMMAND_BRIDGE_HTTP_PORT)

  case "${host}" in
    0.0.0.0)
      host=127.0.0.1
      ;;
    :: | ::1)
      host='[::1]'
      ;;
    *:*)
      host="[${host}]"
      ;;
  esac

  printf 'http://%s:%s/health\n' "${host}" "${port}"
}

rollback_activation() {
  local labels_ok=1
  ROLLBACK_IN_PROGRESS=1
  log "Rolling back the activated release..."
  if [[ "${LEGACY_MIGRATION}" == "1" ]]; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  elif [[ -n "${PREVIOUS_RELEASE}" ]]; then
    # A failed label repair below must not leave the rejected candidate running.
    systemctl stop "${SERVICE_NAME}.service" || log "WARNING: Candidate service could not be stopped during rollback."
  fi
  if [[ -n "${CONFIG_BACKUP}" && -f "${CONFIG_BACKUP}" ]]; then
    install -m 0600 "${CONFIG_BACKUP}" "${CONFIG_FILE}"
  fi
  if [[ "${LEGACY_MIGRATION}" == "1" && -n "${LEGACY_CONFIG_BACKUP}" && -f "${LEGACY_CONFIG_BACKUP}" ]]; then
    install -m 0600 "${LEGACY_CONFIG_BACKUP}" "${CONFIG_FILE}"
  fi

  rollback_audit_access
  if [[ "${LEGACY_MIGRATION}" == "0" && -z "${PREVIOUS_RELEASE}" ]]; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  fi
  if [[ -n "${PREVIOUS_RUNTIME}" && -d "${PREVIOUS_RUNTIME}" ]]; then
    ln -sfnT "${PREVIOUS_RUNTIME}" "${RUNTIME_LINK}"
  elif [[ -L "${RUNTIME_LINK}" ]]; then
    unlink "${RUNTIME_LINK}" || true
  fi
  if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" ]]; then
    ln -sfnT "${PREVIOUS_RELEASE}" "${CURRENT_LINK}"
  elif [[ -L "${CURRENT_LINK}" ]]; then
    unlink "${CURRENT_LINK}" || true
  fi
  if [[ "${UNIT_WAS_PRESENT}" == "1" && -f "${PREVIOUS_UNIT_BACKUP}" ]]; then
    install -m 0644 "${PREVIOUS_UNIT_BACKUP}" "${UNIT_FILE}"
  elif [[ -e "${UNIT_FILE}" || -L "${UNIT_FILE}" ]]; then
    unlink "${UNIT_FILE}" || true
  fi
  if [[ "${LEGACY_MIGRATION}" == "1" && -n "${LEGACY_UNIT_BACKUP}" && \
        -f "${LEGACY_UNIT_BACKUP}" && ! -f "${LEGACY_UNIT_FILE}" ]]; then
    install -m 0644 "${LEGACY_UNIT_BACKUP}" "${LEGACY_UNIT_FILE}" || true
  fi
  if [[ "${LEGACY_MIGRATION}" == "1" ]]; then
    if [[ "${LEGACY_APP_PRESENT}" == "1" ]]; then restore_legacy_tree "${LEGACY_INSTALL_ROOT}" "${INSTALL_ROOT}" || true; fi
    if [[ "${LEGACY_CONFIG_PRESENT}" == "1" ]]; then restore_legacy_tree "${LEGACY_CONFIG_DIR}" "${CONFIG_DIR}" || true; fi
    if [[ "${LEGACY_STATE_PRESENT}" == "1" ]]; then restore_legacy_tree "${LEGACY_STATE_DIR}" "${STATE_DIR}" || true; fi
    if [[ -n "${LEGACY_CURRENT_TARGET}" && -d "${LEGACY_INSTALL_ROOT}" ]]; then
      ln -sfnT "${LEGACY_CURRENT_TARGET}" "${LEGACY_INSTALL_ROOT}/current" || true
    fi
    if [[ -n "${LEGACY_RUNTIME_TARGET}" && -d "${LEGACY_INSTALL_ROOT}/runtime" ]]; then
      ln -sfnT "${LEGACY_RUNTIME_TARGET}" "${LEGACY_INSTALL_ROOT}/runtime/current" || true
    fi
    restore_selinux_layout "${LEGACY_INSTALL_ROOT}" "${LEGACY_CONFIG_DIR}" "${LEGACY_STATE_DIR}" \
      "${LEGACY_UNIT_FILE}" "${LEGACY_AUDIT_READER_DIR}" "${LEGACY_AUDIT_SUDOERS_FILE}" || labels_ok=0
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "${LEGACY_WAS_ENABLED}" == "1" ]]; then
      systemctl enable "${LEGACY_SERVICE_NAME}.service" >/dev/null 2>&1 || true
    fi
    if [[ "${LEGACY_WAS_ACTIVE}" == "1" && "${labels_ok}" == 1 ]]; then
      systemctl reset-failed "${LEGACY_SERVICE_NAME}.service" >/dev/null 2>&1 || true
      systemctl restart "${LEGACY_SERVICE_NAME}.service" || log "WARNING: Legacy service could not be restarted."
    fi
  else
    restore_current_selinux_layout || labels_ok=0
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" && "${labels_ok}" == 1 ]]; then
      # Failed candidate starts can exhaust StartLimitBurst. Clear that candidate's
      # failure counter before restarting the restored, previously verified release.
      systemctl reset-failed "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
      systemctl restart "${SERVICE_NAME}.service" || log "WARNING: Restored service could not be restarted."
    fi
  fi
  [[ "${labels_ok}" == 1 ]] || log "WARNING: Rollback files restored, but SELinux label repair failed; restored service was not restarted."
  ACTIVATION_STARTED=0
  if [[ "${LEGACY_MIGRATION}" == "1" ]]; then LEGACY_ROLLBACK_DONE=1; fi
  ROLLBACK_IN_PROGRESS=0
}

install_and_start_service() {
  local url healthy=0 health_host_header
  local -a curl_options

  install -m 0644 "${TEMP_DIR}/${SERVICE_NAME}.service" "${UNIT_FILE}"
  restore_selinux_path "${UNIT_FILE}" || fail "Could not prepare SELinux label for the systemd unit."
  systemctl daemon-reload
  if [[ "${LEGACY_MIGRATION}" == "0" ]]; then
    systemctl enable "${SERVICE_NAME}.service" >/dev/null
  fi

  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    systemctl restart "${SERVICE_NAME}.service"
  else
    systemctl start "${SERVICE_NAME}.service"
  fi

  url=$(health_url)
  health_host_header=$(read_config_value COMMAND_BRIDGE_ALLOWED_HOSTS)
  health_host_header=${health_host_header%%,*}
  health_host_header=${health_host_header//[[:space:]]/}
  curl_options=(--fail --silent --show-error --max-time 2 --noproxy '*')
  if [[ -n "${health_host_header}" ]]; then
    curl_options+=(--header "Host: ${health_host_header}")
  fi
  log "Waiting for ${url}..."
  for (( attempt = 1; attempt <= 20; attempt++ )); do
    if systemctl is-active --quiet "${SERVICE_NAME}.service" && \
      curl "${curl_options[@]}" "${url}" | \
        grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      healthy=1
      break
    fi
    sleep 1
  done

  if [[ "${healthy}" != "1" ]]; then
    report_execution_context
    journalctl --no-pager --unit "${SERVICE_NAME}.service" --lines 30 >&2 || true
    if [[ "${ACTIVATION_STARTED}" == "1" ]]; then
      rollback_activation
    fi
    fail "Service health check failed. Review the journal output above."
  fi
}

finish_legacy_migration() {
  [[ "${LEGACY_MIGRATION}" == "1" ]] || return 0
  if [[ -f "${LEGACY_UNIT_FILE}" ]]; then
    systemctl enable "${SERVICE_NAME}.service" >/dev/null
    systemctl disable "${LEGACY_SERVICE_NAME}.service" >/dev/null
    systemctl is-active --quiet "${SERVICE_NAME}.service" || fail "New service stopped during migration."
    rm -f -- "${LEGACY_UNIT_FILE}"
    systemctl daemon-reload
  else
    systemctl enable "${SERVICE_NAME}.service" >/dev/null
  fi
  # The old paths remain as exact aliases for existing configuration and local
  # scripts, but the obsolete privileged Audit helper must not remain enabled.
  if [[ -f "${LEGACY_AUDIT_SUDOERS_FILE}" && ! -L "${LEGACY_AUDIT_SUDOERS_FILE}" ]]; then
    rm -f -- "${LEGACY_AUDIT_SUDOERS_FILE}" || log "WARNING: Old audit sudoers rule could not be removed."
  fi
  if [[ -f "${LEGACY_AUDIT_READER_DIR}/audit-reader" && ! -L "${LEGACY_AUDIT_READER_DIR}/audit-reader" ]]; then
    rm -f -- "${LEGACY_AUDIT_READER_DIR}/audit-reader" || log "WARNING: Old audit reader could not be removed."
    rmdir -- "${LEGACY_AUDIT_READER_DIR}" >/dev/null 2>&1 || true
  fi
}

print_summary() {
  log "Installation complete."
  printf '\n'
  printf '  Application: %s\n' "${CURRENT_LINK}"
  printf '  Configuration: %s\n' "${CONFIG_FILE}"
  printf '  Working roots: %s\n' "$(read_config_value COMMAND_BRIDGE_ALLOWED_ROOTS)"
  printf '  Service: %s.service (enabled and active)\n' "${SERVICE_NAME}"
  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then
    printf '  Service UID: %s (the original sudo login account)\n' "${INSTALLER_UID}"
    printf '  File Audit: %s/CommandBridgeMCP/audit\n' "${INSTALLER_STATE_DIR}"
    printf '  sudo: existing non-interactive permissions only; no sudoers rule was added\n'
  fi
  printf '\n'
  printf 'Useful commands:\n'
  printf '  sudo systemctl status %s\n' "${SERVICE_NAME}"
  printf '  sudo journalctl -u %s -f\n' "${SERVICE_NAME}"
  printf '  sudo systemctl restart %s\n' "${SERVICE_NAME}"
  printf '\n'
  if [[ "${PRINT_CODEX_SETUP}" == "1" ]]; then
    printf 'A copy-ready Codex setup block containing the bearer token follows.\n'
  else
    printf 'The bearer token was not printed. Read it as root from:\n'
    printf '  %s\n' "${CONFIG_FILE}"
  fi
}

print_codex_setup() {
  local token connection_name token_env

  [[ "${PRINT_CODEX_SETUP}" == "1" ]] || return 0
  if [[ -z "${CODEX_SETUP_URL}" ]]; then
    CODEX_SETUP_URL=$(automatic_codex_url)
  fi
  token=$(read_config_value COMMAND_BRIDGE_BEARER_TOKEN)
  if [[ ! "${token}" =~ ^[A-Za-z0-9._~-]{32,}$ ]]; then
    printf '[CommandBridge] WARNING: The bearer token is missing or unsafe to print; the Codex setup block was not printed.\n' >&2
    return
  fi
  connection_name=$(codex_connection_name)
  token_env="${connection_name^^}_TOKEN"

  printf '\n'
  printf '%s\n' \
    'SECURITY WARNING: The block below contains a bearer token.' \
    'Copy it only into a trusted Codex task. Delete copied notes after setup.' \
    '' \
    '========== BEGIN COPY FOR CODEX ==========' \
    "Configure a user-scoped MCP connection named ${connection_name} on this Codex client." \
    '' \
    'Connection details:' \
    "MCP URL: ${CODEX_SETUP_URL}" \
    "Codex connection name: ${connection_name}" \
    "Token environment variable: ${token_env}" \
    "Bearer token (secret): ${token}" \
    ''

  if [[ "${CODEX_SETUP_URL}" == http://* ]]; then
    printf '%s\n' \
      'This HTTP URL comes from the saved listener configuration; it does not provide TLS.' \
      'Use it only over a trusted LAN or VPN. Firewall rules are not changed automatically.' \
      'Loopback addresses work only on this host. Existing configuration is preserved.' \
      'If DHCP changes this IP, update the listener, allowed hosts and client URL.' \
      ''
  fi

  printf '%s\n' \
    'Complete these steps:' \
    '1. Inspect the existing user-level ~/.codex/config.toml and user environment.' \
    '   If this connection name or token variable already belongs to a different' \
    '   host, choose an unused connection name and its uppercase NAME_TOKEN variable.' \
    '   Never overwrite the existing connection or its token. Keep the URL and' \
    '   token variable below together when choosing a new name.' \
    '2. Detect the client operating system. Persist this bearer token in the user' \
    "   environment variable ${token_env}. Do not store it in the repository or TOML." \
    '3. Add this user-level Codex configuration in ~/.codex/config.toml:' \
    '' \
    "[mcp_servers.${connection_name}]" \
    'enabled = true' \
    "url = \"${CODEX_SETUP_URL}\"" \
    "bearer_token_env_var = \"${token_env}\"" \
    'startup_timeout_sec = 20.0' \
    'tool_timeout_sec = 60.0' \
    '' \
    '4. Preserve every unrelated Codex setting. Tell me exactly what changed and' \
    '   whether Codex must be restarted for the new environment variable.' \
    "5. After restart, use /mcp to verify that ${connection_name} is connected." \
    '6. Do not repeat the bearer token in your final response.' \
    '========== END COPY FOR CODEX =========='
}

main() {
  local node_arch available_kb

  parse_arguments "$@"
  require_root_systemd_linux
  select_service_identity
  for command_name in \
    awk chown chmod cp curl df env flock getent grep groupadd groupdel gzip id install \
    ldd ln mktemp mv od pgrep pkill readlink rmdir runuser sha256sum sleep stat sudo tar \
    tr uname unlink useradd userdel sed; do
    require_command "${command_name}"
  done

  detect_selinux
  collect_codex_setup_url

  install -d -m 0700 -o root -g root "${LOCK_DIR}"
  exec 9>"${LOCK_DIR}/install.lock"
  chmod 0600 "${LOCK_DIR}/install.lock"
  flock -n 9 || fail "Another CommandBridge installation is already running."
  assert_new_installation_paths

  available_kb=$(df -Pk /opt | awk 'NR == 2 { print $4 }')
  if [[ "${available_kb}" =~ ^[0-9]+$ ]] && (( available_kb < 400000 )); then
    fail "At least 400 MB of free space under /opt is required."
  fi

  TEMP_DIR=$(mktemp -d /tmp/command-bridge-install.XXXXXX)
  chmod 0755 "${TEMP_DIR}"
  node_arch=$(detect_node_arch)

  prepare_node_runtime "${node_arch}"
  prepare_source
  build_source
  if [[ -f "${CONFIG_FILE}" ]]; then
    DOTENV_CONFIG_PATH="${CONFIG_FILE}" "${TEMP_DIR}/node-runtime/bin/node" "${TEMP_DIR}/source/dist/checkConfig.js"
  elif [[ -f "${LEGACY_CONFIG_DIR}/command-bridge.env" ]]; then
    DOTENV_CONFIG_PATH="${LEGACY_CONFIG_DIR}/command-bridge.env" "${TEMP_DIR}/node-runtime/bin/node" "${TEMP_DIR}/source/dist/checkConfig.js"
  fi
  migrate_legacy_layout
  ensure_service_account
  ensure_installer_state
  install_configuration
  DOTENV_CONFIG_PATH="${CONFIG_FILE}" "${TEMP_DIR}/node-runtime/bin/node" "${TEMP_DIR}/source/dist/checkConfig.js"
  install_runtime_and_release "${node_arch}"
  if [[ "${RUN_AS_INSTALLER}" == 0 ]]; then install_audit_access; fi
  install_and_start_service
  "${RUNTIME_LINK}/bin/node" "${CURRENT_LINK}/scripts/verify-install.mjs" "${CONFIG_FILE}"
  if [[ "${RUN_AS_INSTALLER}" == 1 ]]; then remove_audit_access_for_installer; fi
  finish_legacy_migration
  ACTIVATION_STARTED=0
  INSTALL_SUCCEEDED=1
  print_summary
  print_codex_setup
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
