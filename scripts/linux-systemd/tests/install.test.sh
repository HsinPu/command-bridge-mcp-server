#!/usr/bin/env bash
set -Eeuo pipefail
source scripts/linux-systemd/install.sh
# Only exercise pure functions; disable the installer's cleanup/error handlers.
trap - EXIT ERR

PRINT_CODEX_SETUP=0
setup=$(print_codex_setup)
[[ -z "$setup" ]]

hostname() { printf 'TWT-PELPLMAP06D.example.com\n'; }
[[ "$(codex_connection_name)" == 'cb_twt_pelplmap06d_example_com' ]]
CODEX_SETUP_NAME='cb_oracle_prod'
[[ "$(codex_connection_name)" == 'cb_oracle_prod' ]]
if (parse_arguments --codex-name 'Bad-Name') >/dev/null 2>&1; then
  echo 'Invalid Codex connection name was accepted'; exit 1
fi
if (parse_arguments --codex-name=) >/dev/null 2>&1; then
  echo 'Empty Codex connection name was accepted'; exit 1
fi
CODEX_SETUP_NAME=''
PRINT_CODEX_SETUP=0
parse_arguments --codex-name=cb_oracle_prod
[[ "${PRINT_CODEX_SETUP}" == 1 && "${CODEX_SETUP_NAME}" == 'cb_oracle_prod' ]]
PRINT_CODEX_SETUP=0

token=$(printf '%064d' 1)
for allowed in '192.168.1.20' 'mcp.example.com,127.0.0.1' '[::1]' 'host-name:8800' ''; do
  validate_new_configuration "$token" '127.0.0.1' 8800 "$allowed" allowlist
done
for allowed in 'host name' 'host;command' 'host/other' $'host\nother' 'host\\other'; do
  if (validate_new_configuration "$token" '127.0.0.1' 8800 "$allowed" allowlist) >/dev/null 2>&1; then
    echo 'Invalid Host characters were accepted'; exit 1
  fi
done
validate_new_configuration "$token" '192.168.1.20' 8800 '192.168.1.20' allowlist
if (validate_new_configuration "$token" '192.168.1.20' 8800 '' allowlist) >/dev/null 2>&1; then
  echo 'Missing non-loopback Host was accepted'; exit 1
fi

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
[[ "$setup" == *'[mcp_servers.cb_oracle_prod]'* ]]
[[ "$setup" == *'bearer_token_env_var = "CB_ORACLE_PROD_TOKEN"'* ]]
[[ "$setup" == *'Never overwrite the existing connection or its token.'* ]]
CODEX_SETUP_NAME=''
setup=$(print_codex_setup)
[[ "$setup" == *'[mcp_servers.cb_twt_pelplmap06d_example_com]'* ]]
[[ "$setup" == *'bearer_token_env_var = "CB_TWT_PELPLMAP06D_EXAMPLE_COM_TOKEN"'* ]]
saved_host=::1
[[ "$(automatic_codex_url)" == 'http://[::1]:9900/mcp' ]]
saved_host=127.0.0.1
[[ "$(automatic_codex_url)" == 'http://127.0.0.1:9900/mcp' ]]
CODEX_SETUP_URL='https://mcp.example.com/mcp'
setup=$(print_codex_setup)
[[ "$setup" == *'url = "https://mcp.example.com/mcp"'* ]]
printf 'Linux automatic IP setup checks passed.\n'
