#!/usr/bin/env bash
# No services, system locations or user documents are modified.
set -Eeuo pipefail
work=$(mktemp -d /tmp/cb-config-encoding.XXXXXX)
sed -e "s|readonly CONFIG_DIR=.*|readonly CONFIG_DIR=\"$work/config\"|" \
    -e "s|readonly STATE_DIR=.*|readonly STATE_DIR=\"$work/state\"|" \
    -e "s|readonly SERVICE_GROUP=.*|readonly SERVICE_GROUP=\"$(id -gn)\"|" \
    -e "s|readonly INSTALLER_STATE_DIR=.*|readonly INSTALLER_STATE_DIR=\"$work/installer-state\"|" \
    scripts/linux-systemd/install.sh > "$work/install.sh"
cp scripts/linux-systemd/recovery.sh "$work/"
source "$work/install.sh"
trap - EXIT ERR
trap 'rm -rf --one-file-system -- "$work"' EXIT
TEMP_DIR=$work
RUN_AS_INSTALLER=1; EXISTING_INSTALLER_MODE=1; ENABLE_UNRESTRICTED=0; ENABLE_GUARDED=1
UPDATE_ONLY=0; REFRESH_NETWORK=0; ENABLE_UPLOAD=0; ENABLE_DOWNLOAD=0
mkdir -p "$CONFIG_DIR" "$TEMP_DIR/source/packaging"
cp packaging/policy.example.json "$TEMP_DIR/source/packaging/"
chown() { :; }
install() {
  local -a args=()
  while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
  command install "${args[@]}"
}
for locale in C C.UTF-8; do
  for bom in 0 1; do
    for ending in lf crlf; do
      for final in 0 1; do
        node --input-type=module - "$CONFIG_FILE" "$bom" "$ending" "$final" <<'JS'
import {writeFileSync} from 'node:fs';
const [file,bom,ending,final]=process.argv.slice(2), nl=ending==='lf'?'\n':'\r\n';
const text=(bom==='1'?'\uFEFF':'')+'COMMAND_BRIDGE_EXECUTION_MODE=allowlist'+nl+
  '# 中文🙂 preserved'+nl+'COMMAND_BRIDGE_ALLOWED_ROOTS=/工作/中文'+nl+
  'COMMAND_BRIDGE_BEARER_TOKEN=fixture-only'+nl+'# 最後一行'+(final==='1'?nl:'');
writeFileSync(file,text);writeFileSync(file+'.expected',text.replace('EXECUTION_MODE=allowlist','EXECUTION_MODE=guarded'));
JS
        CONFIG_BACKUP=""; CONFIG_CHANGED=0
        LC_ALL=$locale install_configuration > "$work/output"
        cmp "$CONFIG_FILE" "$CONFIG_FILE.expected"
        restore_configuration
        node --input-type=module - "$CONFIG_FILE" <<'JS'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const file=process.argv[2];assert.equal(readFileSync(file,'utf8'),readFileSync(file+'.expected','utf8').replace('EXECUTION_MODE=guarded','EXECUTION_MODE=allowlist'));
JS
        node --input-type=module - "$CONFIG_FILE" "$bom" "$ending" "$final" "$LEGACY_CONFIG_DIR" "$CONFIG_DIR" "$LEGACY_STATE_DIR" "$STATE_DIR" <<'JS'
import {writeFileSync} from 'node:fs';
const [file,bom,ending,final,oldConfig,newConfig,oldState,newState]=process.argv.slice(2),nl=ending==='lf'?'\n':'\r\n';
const text=(bom==='1'?'\uFEFF':'')+'COMMAND_BRIDGE_POLICY_FILE='+oldConfig+'/policy.json'+nl+
  '# 中文🙂 preserved'+nl+'COMMAND_BRIDGE_ALLOWED_ROOTS='+oldState+'/work'+nl+'# 保留原始文字'+(final==='1'?nl:'');
writeFileSync(file,text);writeFileSync(file+'.expected',text.replace(oldConfig,newConfig).replace(oldState,newState));
JS
        LC_ALL=$locale rewrite_legacy_configuration > "$CONFIG_FILE.migrated"
        cmp "$CONFIG_FILE.migrated" "$CONFIG_FILE.expected"
      done
    done
  done
done
printf 'Linux UTF-8 configuration edits preserve BOM, Chinese, newlines and exact rollback bytes.\n'
