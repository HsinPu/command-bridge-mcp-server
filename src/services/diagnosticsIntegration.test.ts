import test from "node:test";
import assert from "node:assert/strict";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,get} from "node:http";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CommandExecutor} from "./commandExecutor.js";
import {startHttpTransport} from "../transport/httpTransport.js";
import type {AppConfig} from "../config/env.js";
const cfg=():AppConfig=>({transport:"http",bearerToken:"diagnostic-test-token-".repeat(3),httpHost:"127.0.0.1",httpPort:0,allowedHosts:["127.0.0.1"],executionMode:"unrestricted",allowedShells:[process.platform==="win32"?"cmd":"sh"],allowedCommands:new Set(),allowedRoots:[process.cwd()],defaultTimeoutMs:1000,maxTimeoutMs:3000,maxOutputChars:1000,maxParallelCommands:1,passthroughEnv:[]});
test("authenticated MCP diagnostics survive Audit failure in every execution mode while writes remain blocked",async()=>{
 for(const mode of ["allowlist","guarded","unrestricted"] as const){
  const config={...cfg(),executionMode:mode};let auditCalls=0,spawns=0;
  const executor=new CommandExecutor(config,{async write(){auditCalls++;throw Object.assign(new Error("SECRET PATH"),{code:"EACCES"});},async list(){auditCalls++;throw Error("SECRET");}});
  Object.defineProperty(executor,"runProcess",{value:async()=>{spawns++;throw Error("Must not run");}});
  const server=await startHttpTransport(config,executor);const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const client=new Client({name:"diagnostic-test",version:"1"});
  try{
   assert.equal((await fetch(base+"/mcp",{method:"POST"})).status,401);
   const status=await new Promise<number|undefined>((resolve,reject)=>get(base+"/mcp",{headers:{Host:"rejected.example",Authorization:`Bearer ${config.bearerToken}`}},r=>{r.resume();resolve(r.statusCode);}).on("error",reject));assert.equal(status,403);
   await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${config.bearerToken}`}}}));
   const blocked=await client.callTool({name:"command_bridge_run_command",arguments:{command:"echo PRIVATE COMMAND"}});assert.equal(blocked.isError,true);
   const report=await client.callTool({name:"command_bridge_get_diagnostics",arguments:{limit:100}});assert.equal(report.isError,false);
   const data=report.structuredContent as any;assert.equal(data.audit.firstFailure.reason,"permissionDenied");assert.equal(data.mode,"diagnostic-only");assert.equal(data.accepting,false);assert.equal(data.recentRequests.length,1);assert.equal(data.recentRequests[0].phase,"auditUnavailable");
   const filtered=await client.callTool({name:"command_bridge_get_diagnostics",arguments:{auditId:data.recentRequests[0].auditId}});assert.equal((filtered.structuredContent as any).recentRequests.length,1);
   for(const name of ["command_bridge_download_file","command_bridge_update"]){const result=await client.callTool({name,arguments:name.includes("download")?{path:"test.txt"}:{}});assert.equal(result.isError,true);}
   const upload=await client.callTool({name:"command_bridge_upload_file",arguments:{path:"test.txt",contentBase64:"",sha256:"0".repeat(64)}});assert.equal(upload.isError,true);
   const tools=await client.listTools();assert.equal(tools.tools.find(t=>t.name==="command_bridge_get_diagnostics")?.annotations?.readOnlyHint,true);
   assert.equal(auditCalls,1);assert.equal(spawns,0);assert.equal((await fetch(base+"/ready",{headers:{Authorization:`Bearer ${config.bearerToken}`}})).status,503);
   assert.ok(!JSON.stringify(report).includes("PRIVATE"));assert.ok(!JSON.stringify(report).includes(config.bearerToken!));assert.ok(!JSON.stringify(report).includes(process.cwd()));
  }finally{await client.close();await executor.shutdown();await new Promise<void>(r=>server.close(()=>r()));}
 }
});
test("successful commands retain safe result metadata even when terminal Audit withholds output",async()=>{
 let calls=0;const executor=new CommandExecutor(cfg(),{async write(){if(++calls===2)throw Object.assign(new Error("PRIVATE OUTPUT"),{code:"ENOSPC"});},async list(){return {events:[],hasMore:false};}});
 Object.defineProperty(executor,"runProcess",{value:async()=>({ok:true,shell:cfg().allowedShells[0],cwd:process.cwd(),exitCode:0,signal:null,stdout:"PRIVATE OUTPUT",stderr:"PRIVATE ERROR",timedOut:false,truncated:false,durationMs:12})});
 try{await assert.rejects(executor.execute({command:"echo PRIVATE COMMAND"}),(e:any)=>e.code==="AUDIT_LOG_WRITE_FAILED");const report=await executor.diagnostics.get();assert.equal(report.activeCommands,0);assert.equal(report.recentRequests[0]?.exitCode,0);assert.equal(report.recentRequests[0]?.durationMs,12);assert.equal(report.recentRequests[0]?.phase,"auditUnavailable");assert.ok(!JSON.stringify(report).includes("PRIVATE"));}finally{await executor.shutdown();}
});
test("real startup keeps HTTP diagnostics available only when Audit is the failed dependency",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"cb-diagnostic-boot-"));const blocker=join(directory,"not-a-directory");await writeFile(blocker,"sentinel");
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,"127.0.0.1",r));const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
 const config=cfg();const env={...process.env};for(const key of Object.keys(env))if(key.startsWith("COMMAND_BRIDGE_")||key.startsWith("DOTENV_CONFIG_"))delete env[key];
 Object.assign(env,{DOTENV_CONFIG_PATH:join(directory,"absent.env"),COMMAND_BRIDGE_TRANSPORT:"http",COMMAND_BRIDGE_HTTP_HOST:"127.0.0.1",COMMAND_BRIDGE_HTTP_PORT:String(port),COMMAND_BRIDGE_BEARER_TOKEN:config.bearerToken,COMMAND_BRIDGE_EXECUTION_MODE:"unrestricted",COMMAND_BRIDGE_ALLOWED_SHELLS:config.allowedShells[0],COMMAND_BRIDGE_ALLOWED_ROOTS:process.cwd(),COMMAND_BRIDGE_AUDIT_BACKEND:"file",LOCALAPPDATA:blocker,XDG_DATA_HOME:blocker});
 const child=spawn(process.execPath,[join(process.cwd(),"dist/index.js")],{env,stdio:["ignore","ignore","pipe"],windowsHide:true});let stderr="";child.stderr.on("data",b=>{stderr+=b;});const closed=new Promise<void>(r=>child.once("close",()=>r()));
 const client=new Client({name:"startup-diagnostic-test",version:"1"});const base=`http://127.0.0.1:${port}`;
 try{
  const deadline=Date.now()+15000;while(true){try{if((await fetch(base+"/health",{signal:AbortSignal.timeout(500)})).ok)break;}catch{}assert.ok(child.exitCode===null&&Date.now()<deadline,"Diagnostic startup failed");await new Promise(r=>setTimeout(r,100));}
  assert.match(stderr,/diagnostic-only startup/);assert.equal((await fetch(base+"/ready",{headers:{Authorization:`Bearer ${config.bearerToken}`}})).status,503);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp"),{requestInit:{headers:{Authorization:`Bearer ${config.bearerToken}`}}}));const result=await client.callTool({name:"command_bridge_get_diagnostics",arguments:{}});assert.equal(result.isError,false);assert.equal((result.structuredContent as any).mode,"diagnostic-only");
  const blocked=await client.callTool({name:"command_bridge_run_command",arguments:{command:"hostname"}});assert.equal(blocked.isError,true);
 }finally{await client.close();child.kill();await closed;}
 try{
  await assert.rejects(promisify(execFile)(process.execPath,[join(process.cwd(),"dist/index.js")],{env:{...env,COMMAND_BRIDGE_ALLOWED_ROOTS:join(directory,"missing-work")},timeout:15000,windowsHide:true}),(e:any)=>e.code===1&&e.stderr.includes("workingDirectory"));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("real stdio startup exposes diagnostics after Audit fails",async()=>{
 const {StdioClientTransport}=await import("@modelcontextprotocol/sdk/client/stdio.js");
 const directory=await mkdtemp(join(tmpdir(),"cb-diagnostic-stdio-")),blocker=join(directory,"blocked");await writeFile(blocker,"sentinel");
 const env:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&!key.startsWith("COMMAND_BRIDGE_")&&!key.startsWith("DOTENV_CONFIG_"))env[key]=value;
 Object.assign(env,{DOTENV_CONFIG_PATH:join(directory,"missing.env"),COMMAND_BRIDGE_TRANSPORT:"stdio",COMMAND_BRIDGE_EXECUTION_MODE:"unrestricted",COMMAND_BRIDGE_ALLOWED_SHELLS:process.platform==="win32"?"cmd":"sh",COMMAND_BRIDGE_ALLOWED_ROOTS:process.cwd(),LOCALAPPDATA:blocker,XDG_DATA_HOME:blocker});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(process.cwd(),"dist/index.js")],env,stderr:"pipe"});const client=new Client({name:"stdio-diagnostics",version:"1"});
 try{await client.connect(transport);const result=await client.callTool({name:"command_bridge_get_diagnostics",arguments:{}});assert.equal(result.isError,false);assert.equal((result.structuredContent as any).mode,"diagnostic-only");assert.equal((result.structuredContent as any).audit.backend,"file");}finally{await client.close();await transport.close();await rm(directory,{recursive:true,force:true});}
});

test("a completed long request keeps its original start time after volatile history eviction",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const executor=new CommandExecutor({...cfg(),maxParallelCommands:2},{async write(){},async list(){return {events:[],hasMore:false};}});
 Object.defineProperty(executor,"runProcess",{value:async(_shell:unknown,command:string)=>{if(command==="FIRST")await gate;return {ok:true,shell:cfg().allowedShells[0],cwd:process.cwd(),exitCode:0,signal:null,stdout:"",stderr:"",timedOut:false,truncated:false,durationMs:12};}});
 const first=executor.execute({command:"FIRST"});
 try{await new Promise(r=>setImmediate(r));const initial=(await executor.diagnostics.get()).recentRequests[0]!;await new Promise(r=>setTimeout(r,10));for(let i=0;i<110;i++)await executor.execute({command:"NEXT"});assert.equal((await executor.diagnostics.get({auditId:initial.auditId})).recentRequests.length,0);release();await first;const latest=(await executor.diagnostics.get({auditId:initial.auditId})).recentRequests[0]!;assert.equal(latest.startedAt,initial.startedAt);assert.equal(latest.phase,"completed");}
 finally{release();await first;await executor.shutdown();}
});
test("an Audit read failure remains diagnosable after subsequent blocked command writes",async()=>{
 let writes=0;const executor=new CommandExecutor(cfg(),{async write(){writes++;},async list(){throw Object.assign(new Error("PRIVATE reader path"),{code:"EACCES"});}});
 try{await assert.rejects(executor.listAuditEvents(1));const initial=(await executor.diagnostics.get()).audit.firstFailure;assert.equal(initial?.operation,"read");assert.equal(initial?.reason,"permissionDenied");await assert.rejects(executor.execute({command:"hostname"}));const report=await executor.diagnostics.get();assert.deepEqual(report.audit.firstFailure,initial);assert.equal(writes,0);assert.equal(report.mode,"diagnostic-only");assert.ok(!JSON.stringify(report).includes("PRIVATE"));}finally{await executor.shutdown();}
});
