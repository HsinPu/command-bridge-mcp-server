import type { AuditLog, AuditEventList, CommandAuditEvent } from "./auditLog.js";
import { AppError } from "../errors/AppError.js";
import { diagnosticReason, type DiagnosticReason } from "./diagnosticTypes.js";
import { DEFAULT_AUDIT_TIMEOUT_MS } from "../config/auditTimeout.js";
export interface AuditFailure {at:string;operation:"read"|"write";stage:"queued"|"backend"|"admission";reason:DiagnosticReason}
/** A response deadline is not cancellation of an underlying filesystem operation. */
export class BoundedAuditLog implements AuditLog {
  private queue:Promise<unknown>=Promise.resolve();
  private readonly pending=new Set<Promise<unknown>>();
  private unavailable=false;
  private firstFailure:AuditFailure|null=null;
  private activeIo=0;
  private activeKind:"read"|"write"|null=null;
  constructor(private readonly backend:AuditLog,private readonly deadlineMs=DEFAULT_AUDIT_TIMEOUT_MS) {}
  get available():boolean {return !this.unavailable;}
  get storageDirectory():string|undefined {return this.backend.storageDirectory;}
  snapshot() {return {available:this.available,pendingIo:this.activeIo,queued:Math.max(0,this.pending.size-this.activeIo),firstFailure:this.firstFailure?{...this.firstFailure}:null};}
  async drain():Promise<void> {await Promise.allSettled([...this.pending]);}
  write(event:CommandAuditEvent):Promise<void> {return this.run("write",remaining=>this.backend.write(event,remaining));}
  list(limit:number):Promise<AuditEventList> {return this.run("read",remaining=>this.backend.list(limit,remaining));}
  private latch(operation:AuditFailure["operation"],stage:AuditFailure["stage"],reason:DiagnosticReason):void {
    this.unavailable=true;
    if(this.firstFailure) return;
    this.firstFailure={at:new Date().toISOString(),operation,stage,reason};
    // Fixed metadata only, best effort. Never wait for the unavailable Audit sink.
    try {if(!process.stderr.writableNeedDrain) process.stderr.write(JSON.stringify({event:"command_bridge.diagnostic",schemaVersion:1,code:operation==="read"?"AUDIT_LOG_READ_FAILED":"AUDIT_LOG_WRITE_FAILED",...this.firstFailure})+"\n",()=>{});} catch {}
  }
  private async run<T>(kind:"read"|"write",action:(remaining:number)=>Promise<T>):Promise<T> {
    const failure=(cause?:unknown)=>new AppError(kind==="read"?"AUDIT_LOG_READ_FAILED":"AUDIT_LOG_WRITE_FAILED","Audit is unavailable; the operation was not started or its result was withheld.","Inspect host storage and restart the service after resolving the Audit failure. A timed-out write may still finish.",{cause});
    if(this.unavailable) throw failure();
    if(this.pending.size>=64) {this.latch(kind,"admission","queueFull");throw failure();}
    let started=false;
    const deadline=performance.now()+this.deadlineMs;
    const operation=this.queue.then(async()=>{
      if(this.unavailable) throw failure();
      const remaining=deadline-performance.now();
      if(remaining<=0) {this.latch(kind,"queued","deadlineExceeded");throw failure();}
      started=true;this.activeIo++;this.activeKind=kind;
      try {
        const result=await action(remaining);
        if(performance.now()>=deadline) {this.latch(kind,"backend","deadlineExceeded");throw new Error("Audit operation timed out.");}
        return result;
      }
      catch(cause) {this.latch(kind,"backend",diagnosticReason(cause));throw cause;}
      finally {this.activeIo--;this.activeKind=null;}
    });
    this.queue=operation.catch(()=>undefined);
    this.pending.add(operation);
    void operation.finally(()=>this.pending.delete(operation)).catch(()=>undefined);
    let timer:NodeJS.Timeout|undefined;
    try {
      return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        this.latch(kind,started?"backend":"queued","deadlineExceeded");reject(new Error("Audit operation timed out."));
      },this.deadlineMs);})]);
    } catch(cause) {throw failure(cause);}
    finally {if(timer) clearTimeout(timer);}
  }
}
