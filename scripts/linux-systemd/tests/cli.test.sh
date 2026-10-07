#!/usr/bin/env bash
set -Eeuo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# Redirect every launcher mutation to this disposable tree.
sed -e "s|/usr/local/bin/command-bridge|$work/bin/command-bridge|g" -e "s|/usr/local/lib/command-bridge|$work/app|g" scripts/linux-systemd/install.sh > "$work/install.sh"
sed -e "s|/usr/local/bin/command-bridge|$work/bin/command-bridge|g" -e "s|/usr/local/lib/command-bridge|$work/app|g" -e '/^main "\$@"$/d' scripts/linux-systemd/uninstall.sh > "$work/uninstall.sh"
source "$work/install.sh"
source scripts/linux-systemd/layout.sh
source scripts/linux-systemd/program-migration.sh
trap - EXIT ERR
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/app/v1" "$work/app/v2"
owner=0
stat() { if [[ "$2" == %u ]]; then echo "$owner"; elif [[ "$2" == %a ]]; then echo 755; else command stat "$@"; fi; }
restore_selinux_path() { printf '%s\n' "$1" >> "$work/labels"; }
printf '#!/bin/sh\necho old\n' > "$work/app/v1/command-bridge"
printf '#!/bin/sh\necho new\n' > "$work/app/v2/command-bridge"
chmod +x "$work/app/"v*/command-bridge
ln -s "$work/app/v1" "$CURRENT_LINK"
install_cli_entry
[[ "$("$CLI_LINK" --version)" == old ]]
grep -Fxq "$CLI_LINK" "$work/labels"
rollback_cli_entry
[[ ! -L "$CLI_LINK" ]]
install_cli_entry
CLI_LINK_CREATED=0
ln -sfnT "$work/app/v2" "$CURRENT_LINK"
[[ "$("$CLI_LINK" --version)" == new ]]
ln -sfnT "$work/app/v1" "$CURRENT_LINK"
rollback_cli_entry
[[ "$("$CLI_LINK" --version)" == old ]]
remove_test_cli() { bash -c 'source "$1"; trap - ERR; stat() { echo 0; }; remove_cli_entry' _ "$work/uninstall.sh"; }
remove_test_cli
[[ ! -L "$CLI_LINK" ]]
echo foreign > "$CLI_LINK"
if (assert_cli_entry) >/dev/null 2>&1; then exit 1; fi
remove_test_cli
grep -Fxq foreign "$CLI_LINK"
rm "$CLI_LINK"
ln -s "$work/foreign" "$CLI_LINK"
if (assert_cli_entry) >/dev/null 2>&1; then exit 1; fi
remove_test_cli
[[ -L "$CLI_LINK" ]]
owner=1000
if (assert_cli_entry) >/dev/null 2>&1; then exit 1; fi
echo 'Linux CLI collision, labels, release switch, rollback and uninstall checks passed.'
