import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync,spawnSync} from "node:child_process";
const read=(path:string)=>readFileSync(resolve(path),"utf8");
test("fixed diagnostic assets are pinned, protected, activated transactionally and removed on uninstall",()=>{
 const installer=read("scripts/linux-systemd/install.sh"),module=read("scripts/linux-systemd/diagnostics.sh"),uninstall=read("scripts/linux-systemd/uninstall.sh");
 for(const [constant,path] of [["DIAGNOSTIC_READER_SHA256","packaging/linux/diagnostic-reader"],["DIAGNOSTIC_PROGRAM_SHA256","scripts/diagnostics/read-linux.mjs"]]){const hash=createHash("sha256").update(readFileSync(resolve(path!))).digest("hex");assert.ok(installer.includes(`${constant}="${hash}"`));}
 assert.match(module,/#%s ALL=\(root\) NOPASSWD: NOSETENV: \/usr\/local\/libexec\/command-bridge-diagnostics\/reader ""/);
 assert.match(module,/visudo -cf/);assert.match(module,/install -m 0440 -o root -g root/);assert.match(module,/restore_selinux_path "\$asset_root" 1/);
 assert.ok(installer.indexOf("restore_diagnostic_assets || labels_ok=0")<installer.indexOf('systemctl restart "${SERVICE_NAME}.service"'));
 const main=installer.slice(installer.indexOf("main() {"));assert.ok(main.indexOf("install_diagnostic_assets")<main.indexOf("install_and_start_service"));
 assert.match(uninstall,/remove_tree \/usr\/local\/libexec\/command-bridge-diagnostics/);assert.match(uninstall,/rm -f -- \/etc\/sudoers.d\/command-bridge-diagnostics/);
 assert.match(read("scripts/windows/install.ps1"),/scripts\\windows\\diagnostics\\read-diagnostics.ps1/);
 assert.match(read("src/services/selfProtection.ts"),/"\/etc\/sudoers.d\/command-bridge-diagnostics"/);
});
test("Linux fixed reader rejects arguments and filters journal records into known codes only",{skip:process.platform!=="linux"},()=>{
 const root=mkdtempSync(join(tmpdir(),"cb-diag-reader-"));
 try{
  const systemctl=join(root,"systemctl"),journalctl=join(root,"journalctl");
  writeFileSync(systemctl,"#!/bin/sh\nprintf 'LoadState=loaded\\nActiveState=active\\nNRestarts=3\\nExecMainStatus=0\\n'\n",{mode:0o755});
  const entries=[{MESSAGE:"PRIVATE TOKEN AND PATH"},{MESSAGE:JSON.stringify({event:"command_bridge.audit",command:"PRIVATE COMMAND"})},{MESSAGE:JSON.stringify({event:"command_bridge.diagnostic",code:"AUDIT_LOG_READ_FAILED",secret:"PRIVATE"})},{MESSAGE:JSON.stringify({event:"command_bridge.diagnostic",code:"PRIVATE"})}].map(e=>JSON.stringify(e)).join("\n");
  writeFileSync(join(root,"journal.json"),entries);
  writeFileSync(journalctl,`#!/bin/sh\n/bin/cat '${join(root,"journal.json")}'\n`,{mode:0o755});
  // Change only the disposable copy's root check and fixed tool locations.
  const program=read("scripts/diagnostics/read-linux.mjs").replace("process.getuid()!==0","false").replaceAll("/usr/bin/systemctl",systemctl).replaceAll("/usr/bin/journalctl",journalctl);
  const path=join(root,"reader.mjs");writeFileSync(path,program);
  const data=JSON.parse(execFileSync(process.execPath,[path],{encoding:"utf8"}));assert.equal(data.service.state,"running");assert.equal(data.service.restartCount,3);assert.deepEqual(data.errors,[{code:"AUDIT_LOG_READ_FAILED"}]);assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  assert.equal(spawnSync(process.execPath,[path,"unexpected"]).status,64);
  const wrapper=read("packaging/linux/diagnostic-reader");assert.match(wrapper,/\$#.*0.*\$EUID.*0/);assert.match(wrapper,/env -i/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("Windows fixed reader executes natively and returns codes without log contents",{skip:process.platform!=="win32"},()=>{
 const root=mkdtempSync(join(tmpdir(),"cb-diag-windows-"));
 try{
  const logs=join(root,"CommandBridgeMCP","logs");mkdirSync(logs,{recursive:true});
  writeFileSync(join(logs,"CommandBridgeMCP.err.log"),['PRIVATE TOKEN AND PATH',JSON.stringify({event:"command_bridge.diagnostic",code:"AUDIT_LOG_WRITE_FAILED",secret:"PRIVATE"}),JSON.stringify({event:"command_bridge.diagnostic",code:"PRIVATE"})].join("\n"));
  const wrapper=join(root,"test.ps1");const source=resolve("scripts/windows/diagnostics/read-diagnostics.ps1").replaceAll("'","''");
  writeFileSync(wrapper,`function Get-Service { param($Name,$ErrorAction) return @{Status='Running'} }\n. '${source}'\n`);
  const output=execFileSync(join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",wrapper],{encoding:"utf8",windowsHide:true,timeout:15000,env:{...process.env,ProgramData:root}});
  const data=JSON.parse(output);assert.equal(data.service.state,"running");assert.deepEqual(data.errors,[{code:"AUDIT_LOG_WRITE_FAILED"}]);assert.ok(!output.includes("PRIVATE"));assert.ok(!output.includes(root));
  writeFileSync(wrapper,`function Get-Service { param($Name,$ErrorAction) throw 'PRIVATE SERVICE FAILURE' }\n. '${source}'\n`.replaceAll("\\n","\n"));
  const unavailable=JSON.parse(execFileSync(join(process.env.SystemRoot!,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",wrapper],{encoding:"utf8",windowsHide:true,timeout:15000,env:{...process.env,ProgramData:root}}));
  assert.equal(unavailable.service.state,"unknown");assert.equal(unavailable.reader.reason,"readerFailed");assert.ok(!JSON.stringify(unavailable).includes("PRIVATE SERVICE FAILURE"));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("Linux diagnostic activation restores prior assets and numeric UID grants on rollback",{skip:process.platform!=="linux"},()=>{
 const root=mkdtempSync(join(tmpdir(),"cb-diag-deploy-"));
 try{
  const asset=join(root,"libexec","command-bridge-diagnostics"),sudoers=join(root,"sudoers");mkdirSync(sudoers,{recursive:true});mkdirSync(join(root,"libexec"));
  const module=read("scripts/linux-systemd/diagnostics.sh").replaceAll("/usr/local/libexec",join(root,"libexec")).replaceAll("/etc/sudoers.d",sudoers);
  const modulePath=join(root,"module.sh");writeFileSync(modulePath,module);
  const script=join(root,"fixture.sh");
  writeFileSync(script,`#!/bin/bash
set -euo pipefail
# This is also executed by the installer's build account with a minimal PATH.
# Validation tools have fixed system locations; no host privilege is granted.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
source '${modulePath}'
fail() { echo "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null; }
assert_managed_update_directory() { [[ ! -L "$1" ]]; }
restore_selinux_path() { return 0; }
# Model root ownership in a disposable non-root directory; never touch host assets.
stat() { if [[ "$1" == -c && "$2" == %u ]]; then echo 0; else command stat "$@"; fi; }
install() { local -a args=(); while (($#)); do if [[ "$1" == -o || "$1" == -g ]]; then shift 2; else args+=("$1"); shift; fi; done; command install "\${args[@]}"; }
# Recreate fixture-owned read-only destinations to model root's overwrite.
# Preserve the copied mode; the production helper still uses ordinary cp -p.
cp() { command cp --remove-destination "$@"; }
TEMP_DIR='${join(root,"first")}'
mkdir -p "$TEMP_DIR/source/packaging/linux" "$TEMP_DIR/source/scripts/diagnostics"
echo first > "$TEMP_DIR/source/packaging/linux/diagnostic-reader"
echo program > "$TEMP_DIR/source/scripts/diagnostics/read-linux.mjs"
RUN_AS_INSTALLER=1; INSTALLER_UID=777
install_diagnostic_assets
[[ "$(command stat -c %a '${join(sudoers,"command-bridge-diagnostics")}')" == 440 ]]
grep -F '#777 ALL=(root) NOPASSWD: NOSETENV:' '${join(sudoers,"command-bridge-diagnostics")}' >/dev/null
restore_diagnostic_assets
[[ ! -e '${asset}' && ! -e '${join(sudoers,"command-bridge-diagnostics")}' ]]
TEMP_DIR='${join(root,"second")}'
mkdir -p "$TEMP_DIR/source/packaging/linux" "$TEMP_DIR/source/scripts/diagnostics"
echo old > "$TEMP_DIR/source/packaging/linux/diagnostic-reader"
echo program > "$TEMP_DIR/source/scripts/diagnostics/read-linux.mjs"
install_diagnostic_assets
TEMP_DIR='${join(root,"third")}'
mkdir -p "$TEMP_DIR/source/packaging/linux" "$TEMP_DIR/source/scripts/diagnostics"
echo new > "$TEMP_DIR/source/packaging/linux/diagnostic-reader"
echo new-program > "$TEMP_DIR/source/scripts/diagnostics/read-linux.mjs"
INSTALLER_UID=778
install_diagnostic_assets
[[ "$(cat '${join(asset,"reader")}')" == new ]]
restore_diagnostic_assets
[[ "$(cat '${join(asset,"reader")}')" == old ]]
grep -F '#777 ALL=(root) NOPASSWD: NOSETENV:' '${join(sudoers,"command-bridge-diagnostics")}' >/dev/null
chmod 0777 '${join(asset,"reader")}'
if (install_diagnostic_assets) >/dev/null 2>&1; then exit 1; fi
`);
  execFileSync("/bin/bash",[script],{encoding:"utf8",timeout:15000,env:{...process.env,PATH:"/usr/bin:/bin"}});
 }finally{rmSync(root,{recursive:true,force:true});}
});
