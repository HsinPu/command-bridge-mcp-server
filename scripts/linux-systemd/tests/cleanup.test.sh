#!/usr/bin/env bash
set -Eeuo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
sed "s|/opt/command-bridge|${work}/opt/command-bridge|g" scripts/linux-systemd/install.sh > "$work/installer.sh"
export CLEANUP_FIXTURE="$work"
for mode in runtime release; do
  rm -rf -- "$work/opt"
  mkdir -p "$work/source/node-runtime" "$work/opt/command-bridge/releases"
  printf 'keep\n' > "$work/opt/command-bridge/releases/previous"
  mkdir -p "$work/opt/command-bridge/releases/.other.new.keep"
  set +e
  MODE="$mode" bash -c '
    source "$CLEANUP_FIXTURE/installer.sh"
    TEMP_DIR="$CLEANUP_FIXTURE/source"
    BUILT_PACKAGE_VERSION=4.3.3
    SOURCE_REF=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    restore_selinux_path() { :; }
    restore_current_selinux_layout() { :; }
    chown() { :; }
    chmod() { :; }
    install() {
      local target=${@: -1}
      command mkdir -p "$target"
    }
    cp() {
      if [[ "$MODE" == runtime || "$*" == *"/dist"* ]]; then
        printf partial > "${@: -1}/partial"
        return 42
      fi
      command cp "$@"
    }
    install_runtime_and_release x64
  ' > "$work/output" 2>&1
  status=$?
  set -e
  [[ "$status" == 42 ]] || { cat "$work/output"; exit 1; }
  [[ -f "$work/opt/command-bridge/releases/previous" ]]
  [[ -d "$work/opt/command-bridge/releases/.other.new.keep" ]]
  [[ -z "$(find "$work/opt" -name '*.new.[0-9]*' -print)" ]]
  if [[ "$mode" == release ]]; then
    [[ -d "$work/opt/command-bridge/runtime/node-v24.18.0-linux-x64" ]]
  fi
done
# Unexpected paths and symlinks must never be followed or removed.
bash -c '
  source "$CLEANUP_FIXTURE/installer.sh"
  trap - EXIT ERR
  mkdir -p "$RUNTIME_DIR" "$CLEANUP_FIXTURE/outside"
  printf keep > "$CLEANUP_FIXTURE/outside/keep"
  RUNTIME_STAGING="$CLEANUP_FIXTURE/outside"
  cleanup_staging
  [[ -f "$CLEANUP_FIXTURE/outside/keep" ]]
  RUNTIME_STAGING="$RUNTIME_DIR/.node.new.$$"
  ln -s "$CLEANUP_FIXTURE/outside" "$RUNTIME_STAGING"
  cleanup_staging
  [[ -L "$RUNTIME_STAGING" && -f "$CLEANUP_FIXTURE/outside/keep" ]]
  RUNTIME_STAGING=""
  RELEASE_STAGING="$RELEASES_DIR/.release.new.$$"
  mkdir -p "$RELEASE_STAGING"
  CONFIG_BACKUP="$CLEANUP_FIXTURE/config-backup"
  touch "$CONFIG_BACKUP"
  install() { return 1; }
  trap cleanup EXIT
  exit 23
' > "$work/boundary-output" 2>&1 && exit 1 || status=$?
[[ "$status" == 23 ]]
[[ -z "$(find "$work/opt" -type d -name '*.new.[0-9]*' -print)" ]]
printf 'Deployment failure cleanup and preservation boundaries passed.\n'
