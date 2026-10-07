import {z} from "zod";
import {fileURLToPath} from "node:url";
import {resolve,sep} from "node:path";
import {version} from "../version.js";
import type {AppConfig} from "../config/env.js";
import {AppError} from "../errors/AppError.js";
import {hostDiagnosticSchema,storageDiagnosticSchema,type DiagnosticProvider,type DiagnosticOperation,type RecentDiagnosticRequest,diagnosticReason} from "./diagnosticTypes.js";
import {nativeDiagnosticProvider,fileStorageProvider} from "./diagnosticProbe.js";
import type {BoundedAuditLog} from "./boundedAuditLog.js";
import {effectiveAuditBackend} from "./auditLog.js";
export const diagnosticInputSchema=z.object({limit:z.number().int().min(1).max(100).optional(),auditId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional()}).strict();
interface Source {provider:DiagnosticProvider;schema:z.ZodType;operation?:DiagnosticOperation;pending?:Promise<void>;at:number;value?:unknown;reason:string|null}
export class DiagnosticsService {
  private stopping=false;
  private readonly startedAt=new Date().toISOString();
  private readonly sources:Record<string,Source>;
  constructor(private readonly config:AppConfig,private readonly audit:BoundedAuditLog,private readonly runtime:()=>{accepting:boolean;mode:string;activeCommands:number;maxParallelCommands:number;recentRequests:RecentDiagnosticRequest[]},providers?:{host:DiagnosticProvider;storage?:DiagnosticProvider},private readonly deadlineMs=5000) {
    const modulePath=fileURLToPath(import.meta.url);
    const managedRoot=process.platform==="win32"?resolve(process.env.ProgramFiles??"C:\\Program Files","CommandBridgeMCP")+sep:"/usr/local/lib/command-bridge/";
    const managed=process.platform==="win32"?modulePath.toLowerCase().startsWith(managedRoot.toLowerCase()):modulePath.startsWith(managedRoot);
    const runtimeOnly:DiagnosticProvider={start:()=>({cancel(){},result:Promise.resolve({schemaVersion:1,service:{state:"notInstalled",restartCount:null,exitCode:null},reader:{status:"notInstalled",reason:null},storage:[],errors:[]})})};
    this.sources={host:{provider:providers?.host??(managed?nativeDiagnosticProvider():runtimeOnly),schema:hostDiagnosticSchema,at:0,reason:null}};
    const storage=providers?.storage??(audit.storageDirectory?fileStorageProvider(audit.storageDirectory):undefined);
    if(storage) this.sources.auditStorage={provider:storage,schema:storageDiagnosticSchema,at:0,reason:null};
  }
  async drain():Promise<void> {await Promise.allSettled(Object.values(this.sources).map(s=>s.pending));}
  stop():void {this.stopping=true;for(const s of Object.values(this.sources))s.operation?.cancel();}
  private start(s:Source):void {
    if(this.stopping||s.pending||Date.now()-s.at<2000) return;
    s.reason=null;
    try{s.operation=s.provider.start();}catch(error){s.value=undefined;s.reason=diagnosticReason(error);s.at=Date.now();return;}
    const pending=s.operation.result.then(value=>{const parsed=s.schema.safeParse(value);if(!parsed.success){s.reason="readerFailed";s.value=undefined;}else{s.value=parsed.data;s.reason=null;}},error=>{s.value=undefined;s.reason=diagnosticReason(error);}).finally(()=>{s.at=Date.now();s.pending=undefined;s.operation=undefined;});
    s.pending=pending;
  }
  async get(input:unknown={},signal?:AbortSignal) {
    const options=diagnosticInputSchema.parse(input);
    if(signal?.aborted) throw new AppError("DIAGNOSTIC_CANCELLED","Diagnostic query was cancelled.");
    for(const s of Object.values(this.sources))this.start(s);
    let timer:NodeJS.Timeout|undefined,abort:(()=>void)|undefined;
    try {
      await Promise.race([Promise.all(Object.values(this.sources).map(s=>s.pending)),new Promise<void>(resolve=>{timer=setTimeout(resolve,this.deadlineMs);}),new Promise<never>((_,reject)=>{abort=()=>reject(new AppError("DIAGNOSTIC_CANCELLED","Diagnostic query was cancelled."));signal?.addEventListener("abort",abort,{once:true});})]);
    } finally {if(timer)clearTimeout(timer);if(abort)signal?.removeEventListener("abort",abort);}
    const probes=Object.fromEntries(Object.entries(this.sources).map(([name,s])=>[name,{status:s.pending?"pending":s.reason?"unavailable":"ok",reason:s.pending?"deadlineExceeded":s.reason,observedAt:s.at?new Date(s.at).toISOString():null,data:s.value??null}]));
    const state=this.runtime();
    const recentRequests=state.recentRequests.filter(e=>!options.auditId||e.auditId===options.auditId).slice(0,options.limit??20);
    const report={schemaVersion:1,version,observedAt:new Date().toISOString(),startedAt:this.startedAt,processUptimeSeconds:Math.floor(process.uptime()),audit:{backend:effectiveAuditBackend(this.config),...this.audit.snapshot()},...state,recentRequests,partial:Object.values(this.sources).some(s=>s.pending||s.reason||(s.value as {reader?:{status:string};status?:string})?.reader?.status==="unavailable"||(s.value as {status?:string})?.status==="unavailable"),probes};
    if(Buffer.byteLength(JSON.stringify(report))>64*1024) throw new AppError("DIAGNOSTIC_OUTPUT_LIMIT","Diagnostic summary exceeded its limit.");
    return report;
  }
}
