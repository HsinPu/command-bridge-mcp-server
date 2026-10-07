import {spawn} from "node:child_process";
import {constants} from "node:fs";
import {open,lstat,statfs} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {AppError} from "../errors/AppError.js";
import {buildWindowsAuditEnvironment} from "./auditLog.js";
import {diagnosticReason,type DiagnosticProvider} from "./diagnosticTypes.js";
export function nativeDiagnosticProvider():DiagnosticProvider {
  const windows=process.platform==="win32";
  const systemRoot=process.env.SystemRoot??"C:\\Windows";
  return {start:()=>startDiagnosticProcess(windows?join(systemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"):"/usr/bin/sudo",windows?["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",fileURLToPath(new URL("../../scripts/windows/diagnostics/read-diagnostics.ps1",import.meta.url))]:["-n","/usr/local/libexec/command-bridge-diagnostics/reader"],windows?buildWindowsAuditEnvironment(systemRoot):{PATH:"/usr/sbin:/usr/bin:/sbin:/bin",LANG:"C"},windows?4000:3000)};
}
/** Internal process runner; MCP callers cannot choose its executable or arguments. */
export function startDiagnosticProcess(executable:string,args:string[],env:NodeJS.ProcessEnv,timeoutMs=3000) {
    const windows=process.platform==="win32";
    const systemRoot=process.env.SystemRoot??"C:\\Windows";
    const child=spawn(executable,args,{env,windowsHide:true,detached:!windows,stdio:["ignore","pipe","ignore"]});
    let output="",fault:string|null=null,ended=false,killing=false;
    const cancel=()=>{
      if(ended||killing) return;killing=true;fault??="DIAGNOSTIC_HELPER_TIMEOUT";
      if(!child.pid) return;
      if(!windows) {try {process.kill(-child.pid,"SIGKILL");}catch {try{child.kill("SIGKILL");}catch{}}}
      else {
        const killer=spawn(join(systemRoot,"System32/taskkill.exe"),["/pid",String(child.pid),"/t","/f"],{windowsHide:true,stdio:"ignore"});
        const timer=setTimeout(()=>killer.kill(),1000);
        killer.once("error",()=>clearTimeout(timer));killer.once("close",()=>clearTimeout(timer));
      }
    };
    const timer=setTimeout(cancel,timeoutMs);
    const result=new Promise<unknown>((resolve,reject)=>{
      child.stdout.on("data",(data:Buffer)=>{if(Buffer.byteLength(output)+data.length>32*1024){fault="DIAGNOSTIC_OUTPUT_LIMIT";cancel();return;}output+=data.toString("utf8");});
      child.once("error",error=>{ended=true;clearTimeout(timer);reject(error);});
      child.once("close",code=>{ended=true;clearTimeout(timer);if(fault||code!==0){reject(new AppError(fault??"DIAGNOSTIC_READER_FAILED","Diagnostic reader unavailable."));return;}try{resolve(JSON.parse(output));}catch{reject(new AppError("DIAGNOSTIC_READER_FAILED","Invalid diagnostic record."));}});
    });
    return {result,cancel};
}
export function fileStorageProvider(directory:string):DiagnosticProvider {
  return {start:()=>({cancel(){},result:(async()=>{
    let freeMb:number|null=null;
    try {
      const info=await lstat(directory);
      if(!info.isDirectory()||info.isSymbolicLink()) return {status:"unavailable",reason:"permissionDenied",freeMb};
      const disk=await statfs(directory);freeMb=Math.max(0,Math.floor(disk.bavail*disk.bsize/1024/1024));
      const file=join(directory,"events.jsonl");
      const stat=await lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()) return {status:"unavailable",reason:"permissionDenied",freeMb};
      const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));await handle.close();
      return {status:"ok",reason:null,freeMb};
    } catch(error){const reason=diagnosticReason(error);return {status:reason==="notFound"&&freeMb!==null?"empty":"unavailable",reason,freeMb};}
  })()})};
}
