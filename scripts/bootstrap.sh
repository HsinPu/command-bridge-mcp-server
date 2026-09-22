#!/usr/bin/env bash
set -Eeuo pipefail
mode=install
if [[ "${1:-}" == "--uninstall" ]]; then mode=uninstall; shift; fi
if [[ "$mode" == uninstall && -f /opt/command-bridge-mcp-server/current/uninstall.sh ]]; then
  [[ "$(stat -c '%u' /opt/command-bridge-mcp-server/current/uninstall.sh)" == 0 ]] || { echo 'Installed uninstaller is not root-owned.' >&2; exit 1; }
  exec bash /opt/command-bridge-mcp-server/current/uninstall.sh "$@"
fi
work=$(mktemp -d /tmp/command-bridge-bootstrap.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt -o "$work/channel.txt" || { echo 'No verified installation channel is available. Wait for a successful main CI run.' >&2; exit 1; }
mapfile -t fields < "$work/channel.txt"
[[ ${#fields[@]} == 2 && "${fields[0]}" =~ ^[a-f0-9]{40}$ && "${fields[1]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid installation channel.' >&2; exit 1; }
sha=${fields[0]}
curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/HsinPu/command-bridge-mcp-server/archive/${sha}.tar.gz" -o "$work/source.tar.gz"
mkdir "$work/source"
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
printf '%s\n' "$sha" > "$work/source/.command-bridge-source-sha"
printf '%s\n' "${fields[1]}" > "$work/source/.command-bridge-source-version"
bash "$work/source/scripts/linux-systemd/${mode}.sh" "$@"
