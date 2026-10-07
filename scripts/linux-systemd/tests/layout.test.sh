#!/bin/bash
# Real filesystem copies/links/deletion in disposable directories; no host services.
set -Eeuo pipefail
work=$(mktemp -d)
trap 'if [[ "${LAYOUT_CROSS_DEVICE:-0}" == 1 ]]; then umount "$work/new"; fi; rm -rf -- "$work"' EXIT
if [[ "${LAYOUT_CROSS_DEVICE:-0}" == 1 ]]; then
  mkdir "$work/new"
  mount -t tmpfs -o size=512m,mode=0755 tmpfs "$work/new"
  [[ "$(command stat -c %d "$work")" != "$(command stat -c %d "$work/new")" ]]
fi
readonly INSTALL_ROOT="$work/new/command-bridge"
readonly PREVIOUS_INSTALL_ROOT="$work/old/command-bridge"
readonly LEGACY_INSTALL_ROOT="$work/old/command-bridge-mcp-server"
source scripts/linux-systemd/layout.sh
source scripts/linux-systemd/program-migration.sh
fail() { echo "$*" >&2; exit 1; }
log() { :; }
restore_current_selinux_layout() { :; }
restore_selinux_path() { :; }
# Model admin ownership of this fixture when npm test is run by a normal user.
# Permission bits, physical files and links are still checked by the real tools.
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
install() {
  local -a args=()
  while (($#)); do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  command install "${args[@]}"
}
expect_failure() { if ( "$@" ) > "$work/failure" 2>&1; then echo "Unexpected success: $*"; exit 1; fi; }
make_app() {
  local root=$1 sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  mkdir -p "$root/releases/v4.5.0-$sha" "$root/runtime/node/bin"
  printf '%s\n' "$sha" > "$root/releases/v4.5.0-$sha/.command-bridge-release"
  printf '{"version":"4.5.0","sourceSha":"%s"}\n' "$sha" > "$root/releases/v4.5.0-$sha/install-info.json"
  printf 'keep-original\n' > "$root/releases/v4.5.0-$sha/preserved"
  printf '#!/bin/sh\necho v24.18.0\n' > "$root/runtime/node/bin/node"
  chmod 0755 "$root/runtime/node/bin/node"
  ln -s "$root/releases/v4.5.0-$sha" "$root/current"
  ln -s "$root/runtime/node" "$root/runtime/current"
}
reset_migration() {
  APP_MIGRATION_STARTED=0; APP_MIGRATION_PREPARED=0; APP_MIGRATION_STAGING=
  APP_ALIAS_NAMES=(); APP_ALIAS_TARGETS=(); APP_ORIGINAL_ROOT=; APP_BACKUP_PATH=
}
reset_migration
inspect_application_layout; [[ -z "$EXISTING_APP_ROOT" ]]
make_app "$PREVIOUS_INSTALL_ROOT"
ln -s "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"
inspect_application_layout; [[ "$EXISTING_APP_ROOT" == "$PREVIOUS_INSTALL_ROOT" ]]
check_deployment_space
BAD_OWNER_PATH=$PREVIOUS_INSTALL_ROOT; expect_failure inspect_application_layout; BAD_OWNER_PATH=
chmod 0777 "$PREVIOUS_INSTALL_ROOT/runtime/node/bin/node"; expect_failure inspect_application_layout
chmod 0755 "$PREVIOUS_INSTALL_ROOT/runtime/node/bin/node"
findmnt() { printf '%s\n' "$PREVIOUS_INSTALL_ROOT/runtime"; }
expect_failure inspect_application_layout
unset -f findmnt
df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 10 9 1 99%% /\n'; }
expect_failure check_deployment_space
unset -f df
# A copy error must leave the original usable and remove partial staging.
copy_failure() {
  trap rollback_application_layout EXIT
  cp() { return 9; }
  prepare_application_migration
}
expect_failure copy_failure
[[ -f "$PREVIOUS_INSTALL_ROOT/current/preserved" && ! -e "$INSTALL_ROOT" ]]
[[ -z "$(find "${INSTALL_ROOT%/*}" -maxdepth 1 -name '.command-bridge-migrate.*' -print)" ]]
prepare_application_migration
[[ -d "$PREVIOUS_INSTALL_ROOT" && ! -L "$PREVIOUS_INSTALL_ROOT" && -d "$INSTALL_ROOT" ]]
[[ "$(readlink -f "$INSTALL_ROOT/current")" == "$INSTALL_ROOT/releases/"* ]]
cmp "$INSTALL_ROOT/current/preserved" "$PREVIOUS_INSTALL_ROOT/current/preserved"
rollback_application_layout
[[ ! -e "$INSTALL_ROOT" && -f "$PREVIOUS_INSTALL_ROOT/current/preserved" ]]
[[ "$(readlink "$LEGACY_INSTALL_ROOT")" == "$PREVIOUS_INSTALL_ROOT" ]]

reset_migration; inspect_application_layout; prepare_application_migration; commit_application_layout
[[ -L "$PREVIOUS_INSTALL_ROOT" && -d "$PREVIOUS_INSTALL_ROOT.migration-backup" ]]
[[ "$(readlink "$LEGACY_INSTALL_ROOT")" == "$INSTALL_ROOT" ]]
rollback_application_layout
[[ -d "$PREVIOUS_INSTALL_ROOT" && ! -L "$PREVIOUS_INSTALL_ROOT" && ! -e "$INSTALL_ROOT" ]]
[[ "$(readlink "$LEGACY_INSTALL_ROOT")" == "$PREVIOUS_INSTALL_ROOT" ]]

reset_migration; inspect_application_layout; prepare_application_migration; commit_application_layout
INSTALL_SUCCEEDED=1; ACTIVATION_STARTED=0; finish_application_migration
[[ ! -e "$PREVIOUS_INSTALL_ROOT.migration-backup" && -L "$PREVIOUS_INSTALL_ROOT" ]]
inspect_application_layout; [[ "$EXISTING_APP_ROOT" == "$INSTALL_ROOT" ]]
# Two real deployments are ambiguous for installation, but verified leftovers
# at all roots must be removable together by the uninstaller.
unlink "$PREVIOUS_INSTALL_ROOT"; make_app "$PREVIOUS_INSTALL_ROOT"
expect_failure inspect_application_layout
mv "$PREVIOUS_INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT.migration-backup"
expect_failure inspect_application_layout
make_app "$PREVIOUS_INSTALL_ROOT"
unlink "$LEGACY_INSTALL_ROOT"; make_app "$LEGACY_INSTALL_ROOT"
sed -e "s|/usr/local/lib/command-bridge|$INSTALL_ROOT|g" \
  -e "s|/opt/command-bridge|$PREVIOUS_INSTALL_ROOT|g" \
  -e '/^main "\$@"$/d' scripts/linux-systemd/uninstall.sh > "$work/uninstall.sh"
cat > "$work/remove.sh" <<'SH'
set -Eeuo pipefail
source "$1/uninstall.sh"
source scripts/linux-systemd/layout.sh
trap - ERR
fail() { echo "$*" >&2; exit 1; }
stat() { if [[ "$2" == %u ]]; then echo 0; elif [[ "$2" == %a && "$3" == /tmp ]]; then echo 755; else command stat "$@"; fi; }
find() { local -a a=(); while (($#)); do if [[ "$1" == -uid && "$2" == 0 ]]; then a+=(-uid "$(id -u)"); shift 2; else a+=("$1"); shift; fi; done; command find "${a[@]}"; }
validate_all_program_removals
DRY_RUN=1; remove_all_program_roots
[[ -f "$INSTALL_ROOT/current/preserved" && -f "$LEGACY_INSTALL_ROOT/current/preserved" ]]
DRY_RUN=0; remove_all_program_roots
SH
bash "$work/remove.sh" "$work" > "$work/removal.log"
for root in "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"; do [[ ! -e "$root" && ! -L "$root" && ! -e "$root.migration-backup" ]]; done
# Foreign roots and escaping aliases must be preserved, never treated as leftovers.
mkdir -p "$PREVIOUS_INSTALL_ROOT"; echo foreign > "$PREVIOUS_INSTALL_ROOT/keep"
expect_failure bash "$work/remove.sh" "$work"
[[ -f "$PREVIOUS_INSTALL_ROOT/keep" ]]
rm -rf -- "$PREVIOUS_INSTALL_ROOT"
mkdir "$work/outside"; echo keep > "$work/outside/keep"
ln -s "$work/outside" "$PREVIOUS_INSTALL_ROOT"
expect_failure inspect_application_layout
expect_failure bash "$work/remove.sh" "$work"
[[ -f "$work/outside/keep" ]]
echo 'Layout migration, intact originals, aliases, rollback, space/ownership rejection and complete uninstall passed.'
