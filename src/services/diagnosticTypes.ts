import { z } from "zod";
export const diagnosticReasonSchema = z.enum(["permissionDenied","noSpace","notFound","helperTimeout","deadlineExceeded","queueFull","outputLimit","readerFailed","cancelled","unknown"]);
export type DiagnosticReason = z.infer<typeof diagnosticReasonSchema>;
export function diagnosticReason(error: unknown): DiagnosticReason {
  let value: unknown = error;
  for (let i=0;i<5 && value instanceof Error;i++) {
    const code=(value as NodeJS.ErrnoException).code;
    if (code==="EACCES" || code==="EPERM") return "permissionDenied";
    if (code==="ENOSPC" || code==="EDQUOT") return "noSpace";
    if (code==="ENOENT") return "notFound";
    if (code==="AUDIT_HELPER_TIMEOUT" || code==="DIAGNOSTIC_HELPER_TIMEOUT") return "helperTimeout";
    if (code==="AUDIT_READER_OUTPUT_LIMIT" || code==="DIAGNOSTIC_OUTPUT_LIMIT") return "outputLimit";
    if (code==="AUDIT_READER_FAILED" || code==="DIAGNOSTIC_READER_FAILED") return "readerFailed";
    value=value.cause;
  }
  return "unknown";
}
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hostDiagnosticSchema=z.object({
  schemaVersion:z.literal(1),
  service:z.object({state:z.enum(["running","stopped","failed","notInstalled","unknown"]),restartCount:count.nullable(),exitCode:z.number().int().nullable()}).strict(),
  reader:z.object({status:z.enum(["ok","notInstalled","unavailable"]),reason:diagnosticReasonSchema.nullable()}).strict(),
  storage:z.array(z.object({resource:z.enum(["application","audit","work"]),freeMb:count.nullable()}).strict()).max(3),
  errors:z.array(z.object({code:z.enum(["AUDIT_LOG_READ_FAILED","AUDIT_LOG_WRITE_FAILED","EACCES","EPERM","ENOENT","ENOSPC","EADDRINUSE","ERR_MODULE_NOT_FOUND"])}).strict()).max(20)
}).strict();
export type HostDiagnostic=z.infer<typeof hostDiagnosticSchema>;
export const storageDiagnosticSchema=z.object({status:z.enum(["ok","empty","unavailable"]),reason:diagnosticReasonSchema.nullable(),freeMb:count.nullable()}).strict();
export type StorageDiagnostic=z.infer<typeof storageDiagnosticSchema>;
export interface DiagnosticOperation { result:Promise<unknown>; cancel():void }
export interface DiagnosticProvider { start():DiagnosticOperation }
export const safeCommandErrors=new Set(["COMMAND_NOT_ALLOWED","COMMAND_POLICY_MISSING","COMMAND_ARGUMENTS_NOT_ALLOWED","SHELL_NOT_ALLOWED","SHELL_SYNTAX_BLOCKED","WORKING_DIRECTORY_NOT_ALLOWED","WORKING_DIRECTORY_UNAVAILABLE","COMMAND_CANCELLED","COMMAND_CONCURRENCY_LIMIT","NO_SHELL_CONFIGURED","COMMAND_BLOCKED","COMMAND_EXECUTION_FAILED","COMMAND_START_FAILED","COMMAND_TERMINATION_FAILED","COMMAND_TIMEOUT","COMMAND_OUTPUT_TRUNCATED","COMMAND_EXIT_NON_ZERO","SELF_MODIFICATION_BLOCKED","DELETE_OPERATION_BLOCKED","SYSTEM_MODIFICATION_BLOCKED","GUARDED_SYNTAX_UNSUPPORTED","AUDIT_LOG_WRITE_FAILED","AUDIT_LOG_READ_FAILED"]);
export interface RecentDiagnosticRequest {auditId:string;startedAt:string;phase:"attempted"|"running"|"completed"|"blocked"|"failed"|"auditUnavailable";durationMs:number|null;exitCode:number|null;timedOut:boolean;errorCode:string|null}
export class RecentDiagnosticRequests {
  private readonly records=new Map<string,RecentDiagnosticRequest>();
  record(event:RecentDiagnosticRequest):void {
    const safe={...event,errorCode:event.errorCode && safeCommandErrors.has(event.errorCode)?event.errorCode:event.errorCode?"UNKNOWN":null};
    this.records.set(event.auditId,safe);
    while(this.records.size>100) this.records.delete(this.records.keys().next().value!);
  }
  list(auditId?:string,limit=20):RecentDiagnosticRequest[] {
    return [...this.records.values()].reverse().filter(e=>!auditId||e.auditId===auditId).slice(0,limit).map(e=>({...e}));
  }
}
