#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture=$(mktemp -d /tmp/command-bridge-permissions.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
fail() { return 1; }
source <(sed -n '/^normalize_program_permissions() {$/,/^}$/p' "$root/scripts/linux-systemd/install.sh")
umask 027
mkdir -p "$fixture/program/dist"
printf 'ok' > "$fixture/program/dist/index.js"
printf 'private' > "$fixture/config.env"
chmod 0600 "$fixture/config.env"
ln -s "$fixture/config.env" "$fixture/program/external"
normalize_program_permissions "$fixture/program"
[[ "$(stat -c %a "$fixture/program/dist")" == 755 ]]
[[ "$(stat -c %a "$fixture/program/dist/index.js")" == 644 ]]
[[ "$(stat -c %a "$fixture/config.env")" == 600 ]]
ln -s "$fixture/program" "$fixture/linked-root"
if normalize_program_permissions "$fixture/linked-root"; then exit 1; fi
printf 'Managed program assets readable under strict umask; external secrets untouched.\n'
