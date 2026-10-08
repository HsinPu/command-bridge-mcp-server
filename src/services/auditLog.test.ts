import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIT_EVENT_NAME,
  MAX_AUDIT_EVENT_LIMIT,
  buildWindowsAuditEnvironment,
  LinuxJournalAuditLog,
  WindowsEventLogAuditLog,
  createAuditEvent,
  parseLinuxJournalLines,
  parseWindowsEventLogLines,
  redactCommand,
  serializeAuditEvent
} from "./auditLog.js";

const rawSecretValues = [
  "super-secret-token",
  "bearer-secret",
  "api-secret",
  "password-secret",
  "url-password",
  "powershell-secret",
  "setx-secret",
  "header-api-secret",
  "ordinary-environment-value",
  "powershell-environment-value"
];

test("redactCommand removes common command credential forms", () => {
  const command = [
    "COMMAND_BRIDGE_BEARER_TOKEN=super-secret-token",
    "curl -H 'Authorization: Bearer bearer-secret'",
    "curl -H \"X-Api-Key: header-api-secret\"",
    "--api-key=api-secret",
    "--password password-secret",
    "https://user:url-password@example.invalid/path",
    "$env:SESSION_TOKEN = 'powershell-secret'",
    "setx API_KEY setx-secret",
    "REGION=ordinary-environment-value Get-Date",
    "$env:REGION = 'powershell-environment-value'"
  ].join(" ; ");

  const redacted = redactCommand(command);

  for (const secret of rawSecretValues) {
    assert.doesNotMatch(redacted, new RegExp(secret));
  }
  assert.match(redacted, /\[REDACTED\]/);
});

test("serialized audit event uses an explicit allowlist and never includes command output", () => {
  const event = Object.assign(
    createAuditEvent({
      auditId: "audit-1",
      timestamp: "2026-07-29T00:00:00.000Z",
      phase: "completed",
      command: "echo safe",
      shell: "bash",
      cwd: "/safe",
      executionMode: "allowlist",
      source: "stdio",
      exitCode: 0,
      durationMs: 12
    }),
    {
      stdout: "must-not-be-audited",
      stderr: "must-not-be-audited",
      bearerToken: "must-not-be-audited",
      environment: { SECRET: "must-not-be-audited" }
    }
  );

  const serialized = serializeAuditEvent(event);

  assert.match(serialized, new RegExp('"event":"' + AUDIT_EVENT_NAME + '"'));
  assert.doesNotMatch(serialized, /must-not-be-audited/);
  assert.doesNotMatch(serialized, /stdout|stderr|bearerToken|environment/);
});

test("Linux journal parser filters unrelated records and redacts again before returning events", () => {
  const unsafeMessage = JSON.stringify({
    ...createAuditEvent({
      auditId: "audit-linux",
      timestamp: "2026-07-29T00:01:00.000Z",
      phase: "attempted",
      command: "echo safe",
      shell: "bash",
      cwd: "/safe",
      executionMode: "allowlist",
      source: "http-bearer"
    }),
    command: "curl --token super-secret-token"
  });
  const output = [
    JSON.stringify({ MESSAGE: "ordinary CommandBridge startup message" }),
    JSON.stringify({ MESSAGE: unsafeMessage }),
    JSON.stringify({ MESSAGE: JSON.stringify({ event: "other.audit" }) })
  ].join("\n");

  const events = parseLinuxJournalLines(output);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.auditId, "audit-linux");
  assert.doesNotMatch(events[0]?.command ?? "", /super-secret-token/);
  assert.match(events[0]?.command ?? "", /\[REDACTED\]/);
});

test("Windows Event Log parser only accepts CommandBridge audit JSON", () => {
  const event = createAuditEvent({
    auditId: "audit-windows",
    timestamp: "2026-07-29T00:02:00.000Z",
    phase: "completed",
    command: "Get-Date",
    shell: "powershell",
    cwd: "C:\\safe",
    executionMode: "allowlist",
    source: "http-bearer",
    exitCode: 0,
    durationMs: 5
  });

  const events = parseWindowsEventLogLines(
    ["not json", JSON.stringify({ event: "other.audit" }), serializeAuditEvent(event)].join("\r\n")
  );

  assert.deepEqual(events.map((candidate) => candidate.auditId), ["audit-windows"]);
});

test("Linux audit log writes one compact redacted JSON line and returns newest events first", async () => {
  const writtenLines: string[] = [];
  const earlier = createAuditEvent({
    auditId: "audit-earlier",
    timestamp: "2026-07-29T00:03:00.000Z",
    phase: "attempted",
    command: "TOKEN=super-secret-token echo safe",
    shell: "bash",
    cwd: "/safe",
    executionMode: "allowlist",
    source: "stdio"
  });
  const later = createAuditEvent({
    auditId: "audit-later",
    timestamp: "2026-07-29T00:04:00.000Z",
    phase: "completed",
    command: "echo safe",
    shell: "bash",
    cwd: "/safe",
    executionMode: "allowlist",
    source: "stdio",
    exitCode: 0
  });
  const logger = new LinuxJournalAuditLog({
    writeLine: async (line) => {
      writtenLines.push(line);
    },
    runReader: async () =>
      [serializeAuditEvent(earlier), serializeAuditEvent(later)].join("\n")
  });

  await logger.write(earlier);
  const listed = await logger.list(1);

  assert.equal(writtenLines.length, 1);
  assert.doesNotMatch(writtenLines[0] ?? "", /super-secret-token/);
  assert.doesNotMatch(writtenLines[0] ?? "", /\n/);
  assert.deepEqual(listed.events.map((event) => event.auditId), ["audit-later"]);
  assert.equal(listed.hasMore, true);
});

test("Windows audit log invokes only its fixed write/read scripts", async () => {
  const calls: Array<{ script: string; eventJson?: string }> = [];
  const event = createAuditEvent({
    auditId: "audit-script",
    timestamp: "2026-07-29T00:05:00.000Z",
    phase: "attempted",
    command: "SECRET=super-secret-token Get-Date",
    shell: "powershell",
    cwd: "C:\\safe",
    executionMode: "allowlist",
    source: "stdio"
  });
  const logger = new WindowsEventLogAuditLog({
    runScript: async (script, eventJson) => {
      calls.push({ script, eventJson });
      return script === "read-audit-events.ps1" ? serializeAuditEvent(event) : "";
    }
  });

  await logger.write(event);
  const result = await logger.list(50);

  assert.deepEqual(calls.map((call) => call.script), [
    "write-audit-event.ps1",
    "read-audit-events.ps1"
  ]);
  assert.doesNotMatch(calls[0]?.eventJson ?? "", /super-secret-token/);
  assert.deepEqual(result.events.map((candidate) => candidate.auditId), ["audit-script"]);
});

test("audit sink write failures are surfaced without embedding raw command data", async () => {
  const logger = new LinuxJournalAuditLog({
    writeLine: async () => {
      throw new Error("writer rejected super-secret-token");
    }
  });
  const event = createAuditEvent({
    phase: "attempted",
    command: "TOKEN=super-secret-token echo safe",
    executionMode: "allowlist",
    source: "stdio"
  });

  await assert.rejects(
    () => logger.write(event),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUDIT_LOG_WRITE_FAILED");
      assert.doesNotMatch((error as Error).message, /super-secret-token/);
      return true;
    }
  );
});


function recentAuditEvents(count: number) {
  return Array.from({length:count}, (_,index)=>createAuditEvent({
    auditId:`audit-${index}`, timestamp:new Date(Date.UTC(2026,9,7)+index*1000).toISOString(),
    phase:"completed", command:"echo --password secret-value", executionMode:"allowlist", source:"stdio"
  }));
}

test("native Audit backends return 1,000 newest events and keep exact hasMore boundaries", async()=>{
  assert.equal(MAX_AUDIT_EVENT_LIMIT,1000);
  for (const count of [100,1000,1001]) {
    const output=recentAuditEvents(count).map(serializeAuditEvent).join("\n");
    for (const audit of [new LinuxJournalAuditLog({runReader:async()=>output}),new WindowsEventLogAuditLog({runScript:async()=>output})]) {
      const result=await audit.list(1000);
      assert.equal(result.events.length,Math.min(count,1000));
      assert.equal(result.events[0].auditId,`audit-${count-1}`);
      assert.equal(result.events.at(-1)?.auditId,`audit-${Math.max(0,count-1000)}`);
      assert.equal(result.hasMore,count>1000);
      assert.doesNotMatch(JSON.stringify(result),/secret-value/);
    }
  }
});

test("all Audit backends reject out-of-range counts before reading storage", async()=>{
 const {FileAuditLog}=await import("./fileAuditLog.js");
 let reads=0;
 const file=new FileAuditLog("unused-invalid-audit-directory");
 for(const audit of [new LinuxJournalAuditLog({runReader:async()=>{reads++;return ""}}),new WindowsEventLogAuditLog({runScript:async()=>{reads++;return ""}}),file]) {
  for (const limit of [0,-1,1.5,1001,NaN,Infinity]) await assert.rejects(audit.list(limit),{code:"AUDIT_LIMIT_INVALID"});
 }
 assert.equal(reads,0);
 const {existsSync}=await import("node:fs");
 assert.equal(existsSync("unused-invalid-audit-directory"),false);
});

test("file Audit returns 1,000 across rotated files and distinguishes an exact boundary", async()=>{
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
 const {FileAuditLog}=await import("./fileAuditLog.js");
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"cb-audit-cap-"));
 try {
  const events=recentAuditEvents(1001);
  const older=path.join(directory,"events.jsonl.1");
  await fs.writeFile(older,events.slice(0,601).map(serializeAuditEvent).join("\n")+"\n",{mode:0o600});
  await fs.writeFile(path.join(directory,"events.jsonl"),events.slice(601).map(serializeAuditEvent).join("\n")+"\n",{mode:0o600});
  const audit=new FileAuditLog(directory);
  const result=await audit.list(1000);
  assert.equal(result.events.length,1000);
  assert.equal(result.events[0].auditId,"audit-1000");
  assert.equal(result.events.at(-1)?.auditId,"audit-1");
  assert.equal(result.hasMore,true);
  assert.doesNotMatch(JSON.stringify(result),/secret-value/);
  await fs.writeFile(older,events.slice(1,601).map(serializeAuditEvent).join("\n")+"\n");
  assert.equal((await audit.list(1000)).hasMore,false);
 } finally {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+"cb-audit-cap-")) throw Error("Unsafe audit fixture cleanup");
  await fs.rm(directory,{recursive:true,force:true});
 }
});

test("fixed Windows reader requests 1,001 provider records and emits only Audit messages",{skip:process.platform!=="win32"},async()=>{
 const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path"),child=await import("node:child_process");
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"cb-reader-cap-"));
 try {
  const events = recentAuditEvents(1001);
  events[0]!.command = "echo 中文🙂"; events[0]!.cwd = "C:\\中文工作目錄";
  await fs.writeFile(path.join(directory,"records.json"),JSON.stringify(events.map(serializeAuditEvent)));
  await fs.copyFile("scripts/windows/audit/read-audit-events.ps1",path.join(directory,"reader.ps1"));
  await fs.writeFile(path.join(directory,"probe.ps1"),`function Get-WinEvent {
 param($FilterHashtable, [int]$MaxEvents, $ErrorAction)
 if ($FilterHashtable.LogName -ne 'Application' -or $FilterHashtable.ProviderName -ne 'CommandBridgeMCP') {throw 'Unexpected reader scope'}
 if ($MaxEvents -ne 1001) {throw 'Reader window is too small'}
 $messages=[IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot,'records.json')) | ConvertFrom-Json
 foreach ($message in $messages) { [pscustomobject]@{Properties=@([pscustomobject]@{Value=$message});Message='unused'} }
}
. ([IO.Path]::Combine($PSScriptRoot,'reader.ps1'))
`);
  const systemRoot=process.env.SystemRoot!;
  const result=child.spawnSync(path.join(systemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(directory,"probe.ps1")],{encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:4*1024*1024,env:buildWindowsAuditEnvironment(systemRoot)});
  assert.equal(result.status,0,result.stderr);
  assert.equal(parseWindowsEventLogLines(result.stdout).length,1001);
  assert.equal(parseWindowsEventLogLines(result.stdout)[0]!.command, events[0]!.command);
  assert.equal(parseWindowsEventLogLines(result.stdout)[0]!.cwd, events[0]!.cwd);
 } finally {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+"cb-reader-cap-")) throw Error("Unsafe reader fixture cleanup");
  await fs.rm(directory,{recursive:true,force:true});
 }
});
