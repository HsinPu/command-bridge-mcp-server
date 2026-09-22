#!/usr/bin/env bash
set -Eeuo pipefail
source scripts/linux-systemd/install.sh
# Only exercise pure functions; disable the installer's cleanup/error handlers.
trap - EXIT ERR

for address in 10.0.0.1 172.16.0.1 172.31.255.1 192.168.1.1 100.64.0.1 100.127.255.1; do
  is_private_ipv4 "$address" || { echo "Rejected private IP: $address"; exit 1; }
done
for address in 8.8.8.8 127.0.0.1 169.254.1.1 172.32.0.1 100.128.0.1 192.168.999.1 ::1; do
  if is_private_ipv4 "$address"; then echo "Accepted invalid IP: $address"; exit 1; fi
done

ip() {
  case "$*" in
    '-4 route show default') printf 'default via 192.168.1.1 dev eth0\n' ;;
    '-4 -o addr show dev eth0 scope global') printf '2: eth0 inet 192.168.1.20/24 scope global eth0\n' ;;
    '-4 -o addr show up scope global') printf '3: eth1 inet 10.0.0.2/24 scope global eth1\n' ;;
    *) return 1 ;;
  esac
}
[[ "$(detect_private_ipv4)" == '192.168.1.20' ]]
[[ "$(default_http_host)" == '192.168.1.20' ]]
CODEX_SETUP_URL='https://mcp.example.com/mcp'
collect_codex_setup_url
[[ "$(default_http_host)" == '127.0.0.1' ]]
CODEX_SETUP_URL=''
collect_codex_setup_url
[[ -z "${CODEX_SETUP_URL}" ]]

ip() {
  case "$*" in
    '-4 route show default') printf 'default via 8.8.8.1 dev eth0\n' ;;
    '-4 -o addr show dev eth0 scope global') printf '2: eth0 inet 8.8.8.8/24 scope global eth0\n' ;;
    '-4 -o addr show up scope global') printf '3: ts0 inet 100.64.10.20/32 scope global ts0\n' ;;
  esac
}
[[ "$(detect_private_ipv4)" == '100.64.10.20' ]]
ip() { return 0; }
[[ "$(detect_private_ipv4)" == '127.0.0.1' ]]

saved_host=10.20.30.40
read_config_value() {
  case "$1" in
    COMMAND_BRIDGE_HTTP_HOST) printf '%s\n' "$saved_host" ;;
    COMMAND_BRIDGE_HTTP_PORT) printf '9900\n' ;;
    COMMAND_BRIDGE_BEARER_TOKEN) printf '%064d\n' 1 ;;
  esac
}
[[ "$(automatic_codex_url)" == 'http://10.20.30.40:9900/mcp' ]]
PRINT_CODEX_SETUP=1
setup=$(print_codex_setup)
[[ "$setup" == *'url = "http://10.20.30.40:9900/mcp"'* ]]
saved_host=::1
[[ "$(automatic_codex_url)" == 'http://[::1]:9900/mcp' ]]
saved_host=127.0.0.1
[[ "$(automatic_codex_url)" == 'http://127.0.0.1:9900/mcp' ]]
CODEX_SETUP_URL='https://mcp.example.com/mcp'
setup=$(print_codex_setup)
[[ "$setup" == *'url = "https://mcp.example.com/mcp"'* ]]
printf 'Linux automatic IP setup checks passed.\n'
