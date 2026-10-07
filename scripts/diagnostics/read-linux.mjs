import {execFileSync} from 'node:child_process';
import {lstatSync,statfsSync} from 'node:fs';
if(process.argv.length!==2||process.getuid()!==0) process.exit(64);
const result={schemaVersion:1,service:{state:'unknown',restartCount:null,exitCode:null},reader:{status:'ok',reason:null},storage:[],errors:[]};
const codes=['AUDIT_LOG_READ_FAILED','AUDIT_LOG_WRITE_FAILED','EACCES','EPERM','ENOENT','ENOSPC','EADDRINUSE','ERR_MODULE_NOT_FOUND'];
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:1200,maxBuffer:256*1024,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C'},stdio:['ignore','pipe','ignore']});
try {
 const text=run('/usr/bin/systemctl',['show','command-bridge.service','--property=LoadState,ActiveState,NRestarts,ExecMainStatus']);
 const props=Object.fromEntries(text.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}));
 result.service.state=props.LoadState==='not-found'?'notInstalled':props.ActiveState==='active'?'running':props.ActiveState==='failed'?'failed':props.ActiveState==='inactive'?'stopped':'unknown';
 for(const [key,source] of [['restartCount','NRestarts'],['exitCode','ExecMainStatus']]) if(/^\d{1,10}$/.test(props[source]??'')) result.service[key]=Number(props[source]);
} catch {result.reader={status:'unavailable',reason:'readerFailed'};}
for(const [resource,path] of [['application','/opt/command-bridge'],['audit','/var/log'],['work','/var/lib/command-bridge']]) {
 let freeMb=null;
 try {if(!lstatSync(path).isSymbolicLink()){const fs=statfsSync(path);freeMb=Math.max(0,Math.floor(fs.bavail*fs.bsize/1024/1024));}} catch {}
 result.storage.push({resource,freeMb});
}
try {
 const text=run('/usr/bin/journalctl',['--no-pager','--unit','command-bridge.service','--output=json','--lines=100']);
 for(const line of text.split('\n')) {
  try {const message=JSON.parse(line).MESSAGE;const item=JSON.parse(message);if(item.event==='command_bridge.diagnostic'&&codes.includes(item.code)&&result.errors.length<20)result.errors.push({code:item.code});}catch{}
 }
} catch {result.reader={status:'unavailable',reason:'readerFailed'};}
process.stdout.write(JSON.stringify(result));
