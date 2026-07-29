#!/usr/bin/env bash

set -Eeuo pipefail

readonly SERVICE_NAME="command-bridge-mcp-server"
readonly SERVICE_USER="command-bridge"
readonly SERVICE_GROUP="command-bridge"
readonly SERVICE_HOME="/var/empty/command-bridge"
readonly INSTALL_ROOT="/opt/command-bridge-mcp-server"
readonly RELEASES_DIR="${INSTALL_ROOT}/releases"
readonly RUNTIME_DIR="${INSTALL_ROOT}/runtime"
readonly CURRENT_LINK="${INSTALL_ROOT}/current"
readonly RUNTIME_LINK="${RUNTIME_DIR}/current"
readonly CONFIG_DIR="/etc/command-bridge-mcp-server"
readonly CONFIG_FILE="${CONFIG_DIR}/command-bridge.env"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
readonly STATE_DIR="/var/lib/command-bridge-mcp-server"
readonly WORK_DIR_PATH="${STATE_DIR}/work"
readonly AUDIT_READER_DIR="/usr/local/libexec/command-bridge-mcp-server"
readonly AUDIT_READER_PATH="${AUDIT_READER_DIR}/audit-reader"
readonly AUDIT_SUDOERS_FILE="/etc/sudoers.d/command-bridge-mcp-server-audit-reader"
readonly LOCK_DIR="/run/command-bridge-mcp-server"
readonly SOURCE_REF="v0.3.0"
readonly NODE_VERSION="24.18.0"
readonly NODE_RELEASE_BASE="https://nodejs.org/download/release/v${NODE_VERSION}"
readonly SOURCE_ARCHIVE_URL="https://github.com/HsinPu/command-bridge-mcp-server/archive/refs/tags/${SOURCE_REF}.tar.gz"
readonly SYSTEMD_UNIT_SHA256="39faaea6008bbabcba0c6133a1936cc34273f91df0e1cb5c1da43c1ab0a46014"
readonly AUDIT_READER_SHA256="3c5542591db8ffe3a75f14448d3c57be0f4f8a0d85ac68a355ae59906536acf7"
readonly BUILD_USER="command-bridge-build-$$"
readonly BUILD_GROUP="${BUILD_USER}"
readonly CODEX_SETUP_URL_PLACEHOLDER="https://REPLACE_WITH_PRIVATE_HOSTNAME/mcp"

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

log() {
  printf '[CommandBridge] %s\n' "$*"
}

usage() {
  printf '%s\n' \
    'Usage: sudo bash scripts/linux-systemd/install.sh [options]' \
    '' \
    'Options:' \
    '  --print-codex-setup       Print a copy-ready Codex setup block after installation.' \
    '                            The block contains the bearer token.' \
    '  --codex-url URL           Use this private HTTPS MCP URL in the setup block.' \
    '                            The URL must end in /mcp. Implies --print-codex-setup.' \
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

validate_codex_setup_url() {
  local url=$1

  [[ "${url}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~:@%+-]+)*/mcp/?$ ]] || \
    fail "--codex-url must be a private HTTPS URL ending in /mcp, without credentials, a query, or a fragment."
}

collect_codex_setup_url() {
  [[ "${PRINT_CODEX_SETUP}" == "1" ]] || return

  if [[ -z "${CODEX_SETUP_URL}" && -t 0 ]]; then
    printf '\n'
    printf 'Private HTTPS MCP URL used by Codex (must end in /mcp).\n'
    printf 'Press Enter to print a placeholder instead: '
    IFS= read -r CODEX_SETUP_URL || true
  fi

  if [[ -n "${CODEX_SETUP_URL}" ]]; then
    validate_codex_setup_url "${CODEX_SETUP_URL}"
  else
    CODEX_SETUP_URL="${CODEX_SETUP_URL_PLACEHOLDER}"
  fi
}

cleanup() {
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

require_root_systemd_linux() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this installer as root, for example: sudo bash scripts/linux-systemd/install.sh"
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer supports Linux only."

  require_command systemctl
  require_command visudo
  [[ -x /usr/bin/sudo ]] || fail "Expected sudo at /usr/bin/sudo for the fixed audit reader."
  [[ -x /usr/bin/journalctl ]] || \
    fail "Expected journalctl at /usr/bin/journalctl for the fixed audit reader."
  [[ -d /run/systemd/system ]] || fail "systemd is not running as PID 1 on this host."

  if ldd --version 2>&1 | grep -qi musl; then
    fail "The bundled Node.js runtime requires glibc; musl/Alpine is not supported."
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
  local unit_hash audit_reader_hash

  install -d -m 0755 "${source_dir}"

  if local_source=$(find_local_source); then
    log "Using local CommandBridge source from ${local_source}."
    tar -C "${local_source}" \
      --exclude=.git \
      --exclude=.codegraph \
      --exclude=node_modules \
      --exclude=dist \
      --exclude=.env \
      -cf - . | tar -C "${source_dir}" -xf -
  else
    log "Downloading CommandBridge MCP ${SOURCE_REF}..."
    download_https "${SOURCE_ARCHIVE_URL}" "${TEMP_DIR}/command-bridge-source.tar.gz"
    tar -xzf "${TEMP_DIR}/command-bridge-source.tar.gz" -C "${source_dir}" --strip-components=1
  fi

  [[ -f "${source_dir}/package.json" ]] || fail "Downloaded source is missing package.json."
  [[ -f "${source_dir}/package-lock.json" ]] || fail "Downloaded source is missing package-lock.json."
  [[ -f "${source_dir}/tsconfig.json" ]] || fail "Downloaded source is missing tsconfig.json."
  [[ -f "${source_dir}/src/index.ts" ]] || fail "Downloaded source is missing src/index.ts."
  [[ -f "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" ]] || \
    fail "Downloaded source is missing the systemd unit."
  [[ -f "${source_dir}/packaging/linux/audit-reader" ]] || \
    fail "Downloaded source is missing the audit reader."

  unit_hash=$(sha256sum "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" | awk '{ print $1 }')
  [[ "${unit_hash}" == "${SYSTEMD_UNIT_SHA256}" ]] || \
    fail "The systemd unit does not match the installer-pinned SHA-256 digest."
  audit_reader_hash=$(sha256sum "${source_dir}/packaging/linux/audit-reader" | awk '{ print $1 }')
  [[ "${audit_reader_hash}" == "${AUDIT_READER_SHA256}" ]] || \
    fail "The audit reader does not match the installer-pinned SHA-256 digest."

  install -m 0600 \
    "${source_dir}/packaging/systemd/${SERVICE_NAME}.service" \
    "${TEMP_DIR}/${SERVICE_NAME}.service"
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
  [[ "v${package_version}" == "${SOURCE_REF}" ]] || \
    fail "Package version ${package_version} does not match installer source ${SOURCE_REF}."

  create_build_account "${build_home}"
  install -d -m 0700 -o "${BUILD_USER}" -g "${BUILD_GROUP}" "${build_home}"
  chown -R "${BUILD_USER}:${BUILD_GROUP}" "${source_dir}"

  log "Installing locked npm dependencies without lifecycle scripts..."
  (
    cd "${source_dir}"
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      npm_config_cache="${build_home}/.npm" \
      npm_config_userconfig=/dev/null \
      npm_config_globalconfig=/dev/null \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/npm" ci --ignore-scripts --no-audit --no-fund

    log "Building and testing CommandBridge MCP as an unprivileged user..."
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/node" "${source_dir}/node_modules/typescript/bin/tsc"
    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/node" --test \
        "${source_dir}/dist/services/commandPolicy.test.js" \
        "${source_dir}/dist/services/auditLog.test.js" \
        "${source_dir}/dist/services/commandExecutor.test.js" \
        "${source_dir}/dist/tools/commandBridgeTools.test.js" \
        "${source_dir}/dist/installAssets.test.js" \
        "${source_dir}/dist/uninstallAssets.test.js"

    runuser -u "${BUILD_USER}" -- env -i \
      HOME="${build_home}" \
      npm_config_cache="${build_home}/.npm" \
      npm_config_userconfig=/dev/null \
      npm_config_globalconfig=/dev/null \
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
  [[ "v${package_version}" == "${SOURCE_REF}" ]] || fail "Built package version changed unexpectedly."
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
  local sudoers_staging

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

  runuser -u "${SERVICE_USER}" -- /usr/bin/sudo -n "${AUDIT_READER_PATH}" >/dev/null
}

rollback_audit_access() {
  [[ "${AUDIT_ACCESS_INSTALLED}" == "1" ]] || return

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
  local package_version release_name release_final release_staging

  package_version=${BUILT_PACKAGE_VERSION}
  [[ -n "${package_version}" ]] || fail "Built package version was not recorded."
  release_name="v${package_version}"
  release_final="${RELEASES_DIR}/${release_name}"
  release_staging="${RELEASES_DIR}/.${release_name}.new.$$"

  install -d -m 0755 -o root -g root "${INSTALL_ROOT}" "${RELEASES_DIR}" "${RUNTIME_DIR}"

  if [[ -e "${runtime_final}" ]]; then
    [[ -x "${runtime_final}/bin/node" ]] || fail "Existing runtime is incomplete: ${runtime_final}"
    [[ "$("${runtime_final}/bin/node" --version)" == "v${NODE_VERSION}" ]] || \
      fail "Existing runtime has an unexpected Node.js version."
  else
    install -d -m 0755 "${runtime_staging}"
    cp -a "${TEMP_DIR}/node-runtime/." "${runtime_staging}/"
    chown -R root:root "${runtime_staging}"
    chmod -R go-w "${runtime_staging}"
    mv "${runtime_staging}" "${runtime_final}"
  fi

  if [[ -e "${release_final}" ]]; then
    [[ -f "${release_final}/.command-bridge-release" ]] || \
      fail "Existing release is incomplete: ${release_final}"
  else
    install -d -m 0755 "${release_staging}"
    cp -a \
      "${source_dir}/dist" \
      "${source_dir}/node_modules" \
      "${source_dir}/package.json" \
      "${source_dir}/package-lock.json" \
      "${source_dir}/README.md" \
      "${source_dir}/SECURITY.md" \
      "${release_staging}/"
    printf '%s\n' "${SOURCE_REF}" > "${release_staging}/.command-bridge-release"
    chown -R root:root "${release_staging}"
    chmod -R go-w "${release_staging}"
    mv "${release_staging}" "${release_final}"
  fi

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

  [[ "${allowed_hosts}" =~ ^[A-Za-z0-9.,:_\[\]-]*$ ]] || \
    fail "COMMAND_BRIDGE_ALLOWED_HOSTS contains unsupported characters."
}

install_configuration() {
  local token host port allowed_hosts execution_mode

  install -d -m 0700 -o root -g root "${CONFIG_DIR}"

  if [[ -e "${CONFIG_FILE}" ]]; then
    log "Preserving existing configuration and bearer token at ${CONFIG_FILE}."
    chown root:root "${CONFIG_FILE}"
    chmod 0600 "${CONFIG_FILE}"
    return
  fi

  token=${COMMAND_BRIDGE_BEARER_TOKEN:-$(generate_token)}
  host=${COMMAND_BRIDGE_HTTP_HOST:-127.0.0.1}
  port=${COMMAND_BRIDGE_HTTP_PORT:-8800}
  allowed_hosts=${COMMAND_BRIDGE_ALLOWED_HOSTS:-}
  execution_mode=${COMMAND_BRIDGE_EXECUTION_MODE:-allowlist}
  validate_new_configuration "${token}" "${host}" "${port}" "${allowed_hosts}" "${execution_mode}"

  umask 077
  {
    printf 'COMMAND_BRIDGE_TRANSPORT=http\n'
    printf 'COMMAND_BRIDGE_BEARER_TOKEN=%s\n' "${token}"
    printf 'COMMAND_BRIDGE_HTTP_HOST=%s\n' "${host}"
    printf 'COMMAND_BRIDGE_HTTP_PORT=%s\n' "${port}"
    printf 'COMMAND_BRIDGE_ALLOWED_HOSTS=%s\n' "${allowed_hosts}"
    printf 'COMMAND_BRIDGE_EXECUTION_MODE=%s\n' "${execution_mode}"
    printf 'COMMAND_BRIDGE_ALLOWED_SHELLS=bash\n'
    printf 'COMMAND_BRIDGE_ALLOWED_COMMANDS=uname,hostname,whoami,uptime,date,df,free,ps,pwd\n'
    printf 'COMMAND_BRIDGE_ALLOWED_ROOTS=%s\n' "${WORK_DIR_PATH}"
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
  ROLLBACK_IN_PROGRESS=1
  log "Rolling back the activated release..."

  rollback_audit_access
  if [[ -z "${PREVIOUS_RELEASE}" ]]; then
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
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" ]]; then
    systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  fi
  ACTIVATION_STARTED=0
  ROLLBACK_IN_PROGRESS=0
}

install_and_start_service() {
  local url healthy=0 health_host_header
  local -a curl_options

  install -m 0644 "${TEMP_DIR}/${SERVICE_NAME}.service" "${UNIT_FILE}"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service" >/dev/null

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
    journalctl --no-pager --unit "${SERVICE_NAME}.service" --lines 30 >&2 || true
    if [[ "${ACTIVATION_STARTED}" == "1" ]]; then
      rollback_activation
    fi
    fail "Service health check failed. Review the journal output above."
  fi
}

print_summary() {
  log "Installation complete."
  printf '\n'
  printf '  Application: %s\n' "${CURRENT_LINK}"
  printf '  Configuration: %s\n' "${CONFIG_FILE}"
  printf '  Working root: %s\n' "${WORK_DIR_PATH}"
  printf '  Service: %s.service (enabled and active)\n' "${SERVICE_NAME}"
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
  local token

  [[ "${PRINT_CODEX_SETUP}" == "1" ]] || return
  token=$(read_config_value COMMAND_BRIDGE_BEARER_TOKEN)
  if [[ ! "${token}" =~ ^[A-Za-z0-9._~-]{32,}$ ]]; then
    printf '[CommandBridge] WARNING: The bearer token is missing or unsafe to print; the Codex setup block was not printed.\n' >&2
    return
  fi

  printf '\n'
  printf '%s\n' \
    'SECURITY WARNING: The block below contains a bearer token.' \
    'Copy it only into a trusted Codex task. Delete copied notes after setup.' \
    '' \
    '========== BEGIN COPY FOR CODEX ==========' \
    'Configure a user-scoped MCP server named command_bridge on this Codex client.' \
    '' \
    'Connection details:' \
    "MCP URL: ${CODEX_SETUP_URL}" \
    "Bearer token (secret): ${token}" \
    ''

  if [[ "${CODEX_SETUP_URL}" == "${CODEX_SETUP_URL_PLACEHOLDER}" ]]; then
    printf '%s\n' \
      'The MCP URL above is a placeholder. Before changing any files, ask me for the' \
      'private HTTPS URL that reaches this server and ends in /mcp.' \
      ''
  fi

  printf '%s\n' \
    'Complete these steps:' \
    '1. Detect the local operating system. Store the bearer token in the persistent' \
    '   user environment variable COMMAND_BRIDGE_BEARER_TOKEN. Do not store it in' \
    '   the repository or write it directly into config.toml.' \
    '2. Add or update this user-level Codex configuration in ~/.codex/config.toml:' \
    '' \
    '[mcp_servers.command_bridge]' \
    'enabled = true' \
    "url = \"${CODEX_SETUP_URL}\"" \
    'bearer_token_env_var = "COMMAND_BRIDGE_BEARER_TOKEN"' \
    'startup_timeout_sec = 20.0' \
    'tool_timeout_sec = 60.0' \
    '' \
    '3. Preserve every unrelated Codex setting. Tell me exactly what changed and' \
    '   whether Codex must be restarted for the new environment variable.' \
    '4. After restart, use /mcp to verify that command_bridge is connected.' \
    '5. Do not repeat the bearer token in your final response.' \
    '========== END COPY FOR CODEX =========='
}

main() {
  local node_arch available_kb

  parse_arguments "$@"
  require_root_systemd_linux
  for command_name in \
    awk chown chmod cp curl df env flock getent grep groupadd groupdel gzip id install \
    journalctl ldd ln mktemp mv od pgrep pkill readlink rmdir runuser sha256sum sleep stat sudo tar \
    tr uname unlink useradd userdel visudo; do
    require_command "${command_name}"
  done

  collect_codex_setup_url

  install -d -m 0700 -o root -g root "${LOCK_DIR}"
  exec 9>"${LOCK_DIR}/install.lock"
  chmod 0600 "${LOCK_DIR}/install.lock"
  flock -n 9 || fail "Another CommandBridge installation is already running."

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
  ensure_service_account
  install_runtime_and_release "${node_arch}"
  install_configuration
  install_audit_access
  install_and_start_service
  print_summary
  print_codex_setup
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
