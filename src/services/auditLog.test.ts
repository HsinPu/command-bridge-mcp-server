import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIT_EVENT_NAME,
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
