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
trusted_installed_path() {
  local path=$1 mode resolved
  resolved=$(readlink -f "$path") || return 1
  case "$resolved" in /usr/local/lib/command-bridge/*|/opt/command-bridge/*|/opt/command-bridge-mcp-server/*) ;; *) return 1 ;; esac
  path=$resolved
  while [[ "$path" != / ]]; do
    [[ ! -L "$path" && "$(stat -c %u "$path")" == 0 ]] || return 1
    mode=$(stat -c %a "$path")
    (( (8#$mode & 022) == 0 )) || return 1
    path=${path%/*}; [[ -n "$path" ]] || path=/
  done
}
managed_program_remains() {
  local path
  for path in /usr/local/lib/command-bridge /opt/command-bridge /opt/command-bridge-mcp-server \
    /usr/local/lib/command-bridge.migration-backup /opt/command-bridge.migration-backup /opt/command-bridge-mcp-server.migration-backup \
    /etc/systemd/system/command-bridge.service /etc/systemd/system/command-bridge-mcp-server.service \
    /etc/systemd/system/command-bridge-update.service /usr/local/libexec/command-bridge-diagnostics /usr/local/libexec/command-bridge-update \
    /usr/local/libexec/command-bridge/audit-reader /usr/local/libexec/command-bridge-mcp-server/audit-reader \
    /etc/sudoers.d/command-bridge-audit-reader /etc/sudoers.d/command-bridge-mcp-server-audit-reader \
    /etc/sudoers.d/command-bridge-diagnostics /etc/sudoers.d/command-bridge-update; do
    if [[ -e "$path" || -L "$path" ]]; then return 0; fi
  done
  return 1
}
if [[ "$mode" == uninstall ]]; then
  for installed_root in /usr/local/lib/command-bridge /opt/command-bridge /opt/command-bridge-mcp-server; do
    if [[ -f "$installed_root/current/uninstall.sh" ]]; then
      trusted_installed_path "$installed_root/current/uninstall.sh" || { echo 'Installed uninstaller or its parent is unsafe.' >&2; exit 1; }
      for option in "$@"; do
        case "$option" in --help|-h) exec bash "$installed_root/current/uninstall.sh" "$@" ;; esac
      done
      if grep -Fq 'remove_all_program_roots' "$installed_root/current/uninstall.sh"; then
        trusted_installed_path "$installed_root/current/layout.sh" || { echo 'Installed layout helper is unsafe.' >&2; exit 1; }
        exec bash "$installed_root/current/uninstall.sh" "$@"
      fi
      bash "$installed_root/current/uninstall.sh" "$@"
      # An older uninstaller only knows its own layout. Inspect all known roots
      # and assets before reporting success; use the verified fallback if needed.
      managed_program_remains || exit 0
      echo 'Old uninstaller completed; checking remaining managed deployment assets with the verified uninstaller.'
      break
    fi
  done
fi
installed_root=
installed_sha=
if [[ "$update" == 1 ]]; then
  for candidate in /usr/local/lib/command-bridge /opt/command-bridge /opt/command-bridge-mcp-server; do
    if [[ -f "$candidate/current/install-info.json" ]]; then
      trusted_installed_path "$candidate/current/install-info.json" && trusted_installed_path "$candidate/runtime/current/bin/node" || { echo 'Installed update assets are unsafe.' >&2; exit 1; }
      physical=$(readlink -f "$candidate")
      [[ -z "$installed_root" || "$physical" == "$installed_root" ]] || { echo 'Multiple independent deployments exist; update was not started.' >&2; exit 1; }
      installed_root=$physical
    fi
  done
  [[ -n "$installed_root" ]] || { echo 'No managed installation; use the one-command installer first.' >&2; exit 1; }
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
if [[ "$mode" == uninstall ]]; then
  for option in "$@"; do case "$option" in --dry-run|--help|-h) exit 0 ;; esac; done
  if managed_program_remains; then
    echo 'Uninstallation is incomplete: managed program assets remain. The verified channel uninstaller may be too old; retry after a successful CI publication or inspect the remaining assets.' >&2
    exit 1
  fi
fi
