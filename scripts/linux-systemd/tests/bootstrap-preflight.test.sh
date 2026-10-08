#!/usr/bin/env bash
# Actual bootstrap/layout validators; private files and a simulated service only.
set -Eeuo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export FIXTURE=$work
app="$work/new/command-bridge"
old="$work/old/command-bridge"
legacy="$work/old/command-bridge-mcp-server"
mkdir -p "$work/bin" "$work/source/scripts/linux-systemd" "$work/data"
printf 'keep-token-and-work\n' > "$work/data/keep"
sha=dddddddddddddddddddddddddddddddddddddddd
printf '%s\n4.6.2\n' "$sha" > "$work/channel"
cp scripts/linux-systemd/layout.sh "$work/source/scripts/linux-systemd/layout.sh"
# Use the real uninstaller's pre-stop validation, with a harmless stop marker.
cat > "$work/modern.sh" <<'SH'
#!/bin/bash
set -Eeuo pipefail
readonly INSTALL_ROOT="$FIXTURE/new/command-bridge"
readonly PREVIOUS_INSTALL_ROOT="$FIXTURE/old/command-bridge"
readonly LEGACY_INSTALL_ROOT="$FIXTURE/old/command-bridge-mcp-server"
source "$(dirname "$0")/layout.sh"
fail() { echo "$*" >&2; exit 1; }
# remove_all_program_roots
SH
sed -n '/^validate_all_program_removals()/,/^}/p' scripts/linux-systemd/uninstall.sh >> "$work/modern.sh"
cat >> "$work/modern.sh" <<'SH'
for option in "$@"; do case "$option" in --help|-h) exit 0 ;; esac; done
validate_all_program_removals
printf 'fallback-preflight\n' >> "$FIXTURE/stages"
for option in "$@"; do case "$option" in --dry-run) exit 0 ;; esac; done
printf 'fallback-stop\n' >> "$FIXTURE/stages"
printf stopped > "$FIXTURE/service"
rm -rf -- "$INSTALL_ROOT" "$PREVIOUS_INSTALL_ROOT" "$LEGACY_INSTALL_ROOT"
SH
cat > "$work/bin/stat" <<'SH'
#!/bin/bash
[[ -e "$3" || -L "$3" ]] || exec /usr/bin/stat "$@"
if [[ "$2" == %u ]]; then [[ "$3" != "${BAD_OWNER_PATH:-}" ]] && echo 0 || echo 1234;
elif [[ "$2" == %a && "$3" == /tmp ]]; then echo 755;
else /usr/bin/stat "$@"; fi
SH
cat > "$work/bin/find" <<'SH'
#!/bin/bash
args=()
while (($#)); do
  if [[ "$1" == -uid && "$2" == 0 ]]; then args+=(-uid "$(id -u)"); shift 2;
  else args+=("$1"); shift; fi
done
exec /usr/bin/find "${args[@]}"
SH
cat > "$work/bin/findmnt" <<'SH'
#!/bin/bash
if [[ -n "${MOUNTED_PATH:-}" ]]; then printf '%s\n' "$MOUNTED_PATH";
else /usr/bin/findmnt "$@"; fi
SH
cat > "$work/bin/curl" <<'SH'
#!/bin/bash
set -eu
url=; out=
while (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done
printf '%s\n' "$url" >> "$FIXTURE/requests"
if [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out";
else [[ "${FAIL_ARCHIVE:-0}" == 0 ]] || exit 22; cp "$FIXTURE/archive.tar.gz" "$out"; fi
SH
chmod 0755 "$work/bin/"*
export PATH="$work/bin:$PATH"
sed -e "s|/usr/local/lib/command-bridge|$app|g" -e "s|/opt/command-bridge-mcp-server|$legacy|g" \
    -e "s|/opt/command-bridge|$old|g" -e "s|/etc/systemd/system/|$work/units/|g" \
    -e "s|/usr/local/libexec/|$work/helpers/|g" -e "s|/etc/sudoers.d/|$work/sudoers/|g" \
    scripts/bootstrap.sh > "$work/bootstrap.sh"
archive_modern() {
  cp "$work/modern.sh" "$work/source/scripts/linux-systemd/uninstall.sh"
  cp scripts/linux-systemd/layout.sh "$work/source/scripts/linux-systemd/layout.sh"
  tar -czf "$work/archive.tar.gz" -C "$work" source
}
make_app() {
  local root=$1 release="$1/releases/v4.5.0-$sha"
  mkdir -p "$release" "$root/runtime/node/bin"
  printf '%s\n' "$sha" > "$release/.command-bridge-release"
  printf '#!/bin/bash\nfor option do case "$option" in --help|-h) exit 0 ;; esac; done\necho old-stop >> "$FIXTURE/stages"\nprintf stopped > "$FIXTURE/service"\n' > "$release/uninstall.sh"
  ln -s "$release" "$root/current"
}
reset() {
  chmod 0755 "$work/old" 2>/dev/null || true
  rm -rf -- "$app" "$old" "$legacy"
  : > "$work/stages"; : > "$work/requests"; printf running > "$work/service"
  archive_modern
}
run() { bash "$work/bootstrap.sh" --uninstall --yes "$@" > "$work/result" 2>&1; }
expect_failure() { if run "$@"; then echo 'Unexpected uninstall success'; exit 1; fi; }
assert_preserved() {
  [[ "$(cat "$work/service")" == running && ! -s "$work/stages" ]]
  [[ "$(cat "$work/data/keep")" == keep-token-and-work ]]
}
# Both historical saved scripts must remain unexecuted when another root is
# foreign, mounted, unsafe, or the verified fallback cannot be obtained.
for root in "$old" "$legacy"; do
  reset; make_app "$root"; mkdir -p "$app"; echo foreign > "$app/keep"
  expect_failure --purge
  grep -q 'No managed release identity' "$work/result"
  assert_preserved; [[ -f "$app/keep" && -f "$root/current/uninstall.sh" ]]
  reset; make_app "$root"
  MOUNTED_PATH="$root/runtime" expect_failure
  grep -q 'mounted deployment path' "$work/result"
  assert_preserved; [[ -f "$root/current/uninstall.sh" ]]
  reset; make_app "$root"; mkdir -p "$app"; chmod 0777 "$app"
  expect_failure
  grep -q 'writable by non-administrators' "$work/result"
  assert_preserved
  for failure in FAIL_CHANNEL FAIL_ARCHIVE; do
    reset; make_app "$root"
    export "$failure=1"; expect_failure; unset "$failure"
    assert_preserved; [[ -f "$root/current/uninstall.sh" ]]
  done
  reset; make_app "$root"
  # Even a successfully downloaded legacy channel cannot perform real removal.
  printf '#!/bin/bash\necho downloaded-old-stop >> "$FIXTURE/stages"\n' > "$work/source/scripts/linux-systemd/uninstall.sh"
  tar -czf "$work/archive.tar.gz" -C "$work" source
  expect_failure; grep -q 'too old to validate all known program roots' "$work/result"
  assert_preserved
  reset; make_app "$root"
  rm -- "$work/source/scripts/linux-systemd/layout.sh"
  tar -czf "$work/archive.tar.gz" -C "$work" source
  expect_failure; grep -q 'layout helper is missing or invalid' "$work/result"
  assert_preserved
  reset; make_app "$root"
  run --help; assert_preserved; [[ ! -s "$work/requests" ]]
  run --dry-run; [[ "$(cat "$work/service")" == running && -f "$root/current/uninstall.sh" ]]
  [[ "$(cat "$work/stages")" == fallback-preflight ]]
  : > "$work/stages"
  run
  [[ "$(cat "$work/stages")" == $'fallback-preflight\nfallback-stop' ]]
  [[ ! -e "$root" && "$(cat "$work/data/keep")" == keep-token-and-work ]]
  grep -Fxq "https://github.com/HsinPu/command-bridge-mcp-server/archive/$sha.tar.gz" "$work/requests"
  # A non-root current link cannot be trusted merely because its canonical
  # release file is protected. Refuse before any download or saved execution.
  reset; make_app "$root"
  BAD_OWNER_PATH="$root/current" expect_failure
  grep -q 'Installed uninstaller or its parent is unsafe' "$work/result"
  assert_preserved; [[ ! -s "$work/requests" ]]
done
# Saved modern uninstallers must also reject writable/non-root alias parents,
# even when the new root is selected first and both aliases resolve into it.
for bits in 0777 0775; do
  reset; make_app "$app"
  cp "$work/modern.sh" "$app/current/uninstall.sh"
  cp scripts/linux-systemd/layout.sh "$app/current/layout.sh"
  ln -s "$app" "$old"; ln -s "$old" "$legacy"
  chmod "$bits" "$work/old"
  expect_failure; grep -q 'Installed program parent is unsafe' "$work/result"
  assert_preserved; [[ ! -s "$work/requests" && -L "$old" && -L "$legacy" ]]
done
reset; make_app "$app"
cp "$work/modern.sh" "$app/current/uninstall.sh"
cp scripts/linux-systemd/layout.sh "$app/current/layout.sh"
ln -s "$app" "$old"
BAD_OWNER_PATH="$work/old" expect_failure
assert_preserved; [[ ! -s "$work/requests" ]]
echo 'Uninstall validates before legacy mutation; unsafe aliases, roots, mounts and fallback failures preserve the service and data.'
