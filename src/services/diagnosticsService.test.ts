import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DiagnosticsService,diagnosticInputSchema} from "./diagnosticsService.js";
import {BoundedAuditLog} from "./boundedAuditLog.js";
import {createAuditEvent} from "./auditLog.js";
import {RecentDiagnosticRequests,diagnosticReason,type DiagnosticProvider} from "./diagnosticTypes.js";
import {fileStorageProvider,startDiagnosticProcess} from "./diagnosticProbe.js";
import {permitsDiagnosticStartup} from "../startupPolicy.js";
import type {AppConfig} from "../config/env.js";
const config={transport:"stdio",auditBackend:"file"} as AppConfig;
const runtime=()=>({accepting:true,mode:"normal",activeCommands:0,maxParallelCommands:2,recentRequests:[]});
const host={schemaVersion:1,service:{state:"running",restartCount:2,exitCode:0},reader:{status:"ok",reason:null},storage:[],errors:[]};
const audit=()=>new BoundedAuditLog({async write(){},async list(){return {events:[],hasMore:false};}});
const event=()=>createAuditEvent({command:"SECRET COMMAND",phase:"attempted",executionMode:"guarded",source:"stdio"});
test("diagnostics coalesce actual unfinished work after deadlines and caller cancellation",async()=>{
 let resolve!: (value:unknown)=>void;let starts=0,cancels=0;
 const provider:DiagnosticProvider={start(){starts++;return {result:new Promise(r=>{resolve=r;}),cancel(){cancels++;}};}};
 const service=new DiagnosticsService(config,audit(),runtime,{host:provider},20);
 try {
  const controller=new AbortController();const cancelled=assert.rejects(service.get({},controller.signal),/cancelled/);controller.abort();await cancelled;
  const results=await Promise.all(Array.from({length:12},()=>service.get()));
  assert.ok(results.every(r=>r.partial && r.probes.host.status==="pending"));assert.equal(starts,1);assert.equal(cancels,0);
  resolve(host);await service.drain();const complete=await service.get();assert.equal(complete.partial,false);assert.equal(starts,1);
  assert.equal((complete.probes.host.data as typeof host).service.restartCount,2);
 }finally{resolve(host);service.stop();await service.drain();}
});
test("strict diagnostic inputs and helper schemas reject paths, commands and secret fields",async()=>{
 for(const input of [{limit:0},{limit:101},{auditId:"../../secret"},{command:"hostname"},{path:"private.env"}]) assert.equal(diagnosticInputSchema.safeParse(input).success,false);
 const service=new DiagnosticsService(config,audit(),runtime,{host:{start:()=>({cancel(){},result:Promise.resolve({...host,secret:"TOKEN-PATH-OUTPUT"})})}});
 const report=await service.get();assert.equal(report.partial,true);assert.equal(report.probes.host.reason,"readerFailed");assert.equal(report.probes.host.data,null);assert.ok(!JSON.stringify(report).includes("TOKEN-PATH-OUTPUT"));
 service.stop();await service.drain();
});
test("first Audit failure is classified and preserved without leaking error details",async()=>{
 const backend={async write(){throw Object.assign(new Error("PRIVATE TOKEN AND PATH"),{code:"ENOSPC"});},async list(){throw Error("private query");}};
 const bounded=new BoundedAuditLog(backend);
 await assert.rejects(bounded.write(event()));const original=bounded.snapshot().firstFailure;
 await assert.rejects(bounded.list(1));assert.deepEqual(bounded.snapshot().firstFailure,original);
 assert.equal(original?.reason,"noSpace");assert.equal(original?.operation,"write");assert.equal(original?.stage,"backend");
 const service=new DiagnosticsService(config,bounded,runtime,{host:{start:()=>({cancel(){},result:Promise.resolve(host)})}});
 const report=await service.get();assert.equal(report.audit.available,false);assert.ok(!JSON.stringify(report).includes("PRIVATE"));service.stop();await service.drain();
 assert.equal(diagnosticReason(new Error("permission denied SECRET")),"unknown");
 assert.equal(diagnosticReason(new Error("outer",{cause:Object.assign(new Error("secret"),{code:"EACCES"})})),"permissionDenied");
});
test("Audit snapshots distinguish active I/O, queued operations and admission exhaustion",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const bounded=new BoundedAuditLog({async write(){await gate;},async list(){return {events:[],hasMore:false};}},1000);
 const writes=Array.from({length:64},()=>bounded.write(event()));const settled=Promise.allSettled(writes);
 try {await new Promise(r=>setImmediate(r));assert.equal(bounded.snapshot().pendingIo,1);assert.equal(bounded.snapshot().queued,63);await assert.rejects(bounded.list(1));assert.equal(bounded.snapshot().firstFailure?.stage,"admission");assert.equal(bounded.snapshot().firstFailure?.reason,"queueFull");}
 finally{release();await settled;await bounded.drain();}
 assert.equal(bounded.snapshot().pendingIo,0);assert.equal(bounded.snapshot().queued,0);
});
test("recent command summaries have a fixed bound, literal ID filtering and safe error codes",()=>{
 const records=new RecentDiagnosticRequests();for(let i=0;i<105;i++)records.record({auditId:String(i),startedAt:new Date().toISOString(),phase:"completed",durationMs:10,exitCode:0,timedOut:false,errorCode:i===104?"SECRET":"COMMAND_TIMEOUT"});
 assert.equal(records.list(undefined,100).length,100);assert.equal(records.list()[0]?.auditId,"104");assert.equal(records.list()[0]?.errorCode,"UNKNOWN");assert.equal(records.list("4").length,0);assert.equal(records.list("103")[0]?.errorCode,"COMMAND_TIMEOUT");
 const copy=records.list("103")[0]!;copy.phase="failed";assert.equal(records.list("103")[0]?.phase,"completed");
});
test("file diagnostics inspect metadata without preparing, writing or returning Audit contents",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"cb-diagnostic-storage-"));
 try {const file=join(directory,"events.jsonl");await writeFile(file,"SECRET CONTENT");const before=await stat(file);const report=await fileStorageProvider(directory).start().result as {status:string};assert.equal(report.status,"ok");assert.ok(!JSON.stringify(report).includes("SECRET"));const after=await stat(file);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.mode,before.mode);assert.equal(await readFile(file,"utf8"),"SECRET CONTENT");const absent=join(directory,"absent");assert.equal((await fileStorageProvider(absent).start().result as {status:string}).status,"unavailable");await assert.rejects(stat(absent));}
 finally{await rm(directory,{recursive:true,force:true});}
});
test("native diagnostic subprocesses bound output, terminate hung helpers and classify failures",async()=>{
 const env={...process.env};
 const timeout=startDiagnosticProcess(process.execPath,["-e","setInterval(()=>{},1000)"],env,300);
 await assert.rejects(timeout.result,(e:any)=>e.code==="DIAGNOSTIC_HELPER_TIMEOUT");
 const huge=startDiagnosticProcess(process.execPath,["-e","process.stdout.write('X'.repeat(40000));setInterval(()=>{},1000)"],env,5000);
 await assert.rejects(huge.result,(e:any)=>e.code==="DIAGNOSTIC_OUTPUT_LIMIT");
 const malformed=startDiagnosticProcess(process.execPath,["-e","process.stdout.write('PRIVATE SECRET')"],env,5000);
 await assert.rejects(malformed.result,(e:any)=>e.code==="DIAGNOSTIC_READER_FAILED"&&!e.message.includes("SECRET"));
});
test("diagnostic-only startup requires positively verified non-Audit dependencies",()=>{
 assert.equal(permitsDiagnosticStartup({ready:false,checks:{workingDirectory:true,shells:true,audit:false,accepting:false}}),true);
 const failures:Record<string,boolean>[]=[{audit:false},{audit:false,verification:false},{workingDirectory:false,shells:true,audit:false},{workingDirectory:true,shells:false,audit:false},{workingDirectory:true,shells:true,policyReadOnly:false,audit:false},{workingDirectory:true,shells:true,audit:true}];
 for(const checks of failures) assert.equal(permitsDiagnosticStartup({ready:false,checks}),false);
});

test("completed probe failures are cached briefly, then retried without resetting Audit",async()=>{
 let calls=0;const provider:DiagnosticProvider={start(){calls++;return {cancel(){},result:calls===1?Promise.reject(Object.assign(new Error("private"),{code:"EACCES"})):Promise.resolve(host)};}};
 const bounded=audit();const service=new DiagnosticsService(config,bounded,runtime,{host:provider});
 try{assert.equal((await service.get()).probes.host.reason,"permissionDenied");assert.equal((await service.get()).probes.host.reason,"permissionDenied");assert.equal(calls,1);await new Promise(r=>setTimeout(r,2100));assert.equal((await service.get()).probes.host.status,"ok");assert.equal(calls,2);assert.equal(bounded.available,true);}finally{service.stop();await service.drain();}
});
