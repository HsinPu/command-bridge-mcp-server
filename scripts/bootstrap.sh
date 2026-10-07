#!/usr/bin/env bash
set -Eeuo pipefail
mode=install
update=0
check=0
if [[ "${1:-}" == "--update" ]]; then
  update=1; shift
  case "${1:-}" in
    --check) check=1; shift ;;
    --print-codex-setup) shift; set -- --print-codex-setup "$@" ;;
  esac
  [[ $# == 0 || ( $# == 1 && "$1" == --print-codex-setup && "$check" == 0 ) ]] || { echo 'Usage: command-bridge update [--check|--print-codex-setup]' >&2; exit 2; }
  if [[ "$check" == 0 && "$EUID" != 0 ]]; then echo 'Run sudo command-bridge update from an administrator terminal.' >&2; exit 1; fi
fi
if [[ "${1:-}" == "--uninstall" ]]; then mode=uninstall; shift; fi
if [[ "$mode" == uninstall ]]; then
  for installed_root in /opt/command-bridge /opt/command-bridge-mcp-server; do
    if [[ -f "$installed_root/current/uninstall.sh" ]]; then
      [[ "$(stat -c '%u' "$installed_root/current/uninstall.sh")" == 0 ]] || { echo 'Installed uninstaller is not root-owned.' >&2; exit 1; }
      exec bash "$installed_root/current/uninstall.sh" "$@"
    fi
  done
fi
installed_root=/opt/command-bridge
installed_sha=
if [[ "$update" == 1 ]]; then
  [[ -f "$installed_root/current/install-info.json" && -x "$installed_root/runtime/current/bin/node" ]] || { echo 'No managed installation; use the one-command installer first.' >&2; exit 1; }
  # Metadata is data, not executable configuration. Print only version/SHA.
  installed=$("$installed_root/runtime/current/bin/node" -e 'try { const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!/^[a-f0-9]{40}$/.test(i.sourceSha)||!/^\d+\.\d+\.\d+$/.test(i.version)) throw 0; console.log(i.version+" "+i.sourceSha) } catch { console.error("Invalid installed metadata."); process.exit(1) }' "$installed_root/current/install-info.json")
  installed_sha=${installed#* }
fi
work=$(mktemp -d /tmp/command-bridge-bootstrap.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 -fsSL https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt -o "$work/channel.txt" || { echo 'No verified installation channel is available. Wait for a successful main CI run.' >&2; exit 1; }
mapfile -t fields < "$work/channel.txt"
[[ ${#fields[@]} == 2 && "${fields[0]}" =~ ^[a-f0-9]{40}$ && "${fields[1]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid installation channel.' >&2; exit 1; }
sha=${fields[0]}
if [[ "$update" == 1 ]]; then
  printf 'Installed: %s\nVerified channel: %s %s\n' "$installed" "${fields[1]}" "$sha"
  if [[ "$sha" == "$installed_sha" ]]; then echo 'Already up to date.'; exit 0; fi
  if [[ "$check" == 1 ]]; then echo 'Update available. Run sudo command-bridge update.'; exit 0; fi
  echo 'Updating CommandBridge; the service will restart briefly. Settings and service identity will be preserved.'
  set -- --update --expected-installed-sha "$installed_sha" "$@"
fi
curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/HsinPu/command-bridge-mcp-server/archive/${sha}.tar.gz" -o "$work/source.tar.gz"
mkdir "$work/source"
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
printf '%s\n' "$sha" > "$work/source/.command-bridge-source-sha"
printf '%s\n' "${fields[1]}" > "$work/source/.command-bridge-source-version"
bash "$work/source/scripts/linux-systemd/${mode}.sh" "$@"
