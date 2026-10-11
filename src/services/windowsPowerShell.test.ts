import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildChildEnvironment } from "./commandExecutor.js";
import { buildWindowsAuditEnvironment } from "./auditLog.js";
import { createAuditEvent } from "./auditLog.js";
import { FileAuditLog } from "./fileAuditLog.js";

test("Windows Audit startup excludes secrets and rejects invalid payload without module discovery", { skip: process.platform !== "win32" }, () => {
  const environment = buildWindowsAuditEnvironment(process.env.SystemRoot ?? "C:\\Windows", '{}');
  assert.equal(environment.COMMAND_BRIDGE_BEARER_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.COMMAND_BRIDGE_CMDLET_REQUEST, undefined);
  assert.match(environment.PSModulePath ?? '', /WindowsPowerShell[\\/]v1\.0[\\/]Modules$/);
  const directory = mkdtempSync(join(tmpdir(), "cb-audit-input-"));
  try {
    // Long deployment paths can wrap translated PowerShell errors mid-word.
    // Catch the actual StrictMode error, never infer rejection from formatting.
    const nested = join(directory, "long-'quoted path-" + "x".repeat(80));
    mkdirSync(nested);
    const copied = join(nested, 'write-audit-event.ps1');
    copyFileSync(resolve('scripts/windows/audit/write-audit-event.ps1'), copied);
    for (const script of [resolve('scripts/windows/audit/write-audit-event.ps1'), copied]) {
      const command = `try { & '${script.replaceAll("'", "''")}'; exit 0 } catch {
        if ($_.FullyQualifiedErrorId -eq 'PropertyNotFoundStrict,write-audit-event.ps1' -and
            $_.Exception -is [System.Management.Automation.PropertyNotFoundException]) {
          [Console]::Out.WriteLine('AUDIT_INPUT_REJECTED'); exit 1
        }
        [Console]::Out.WriteLine('UNEXPECTED_AUDIT_FAILURE'); exit 2
      }`;
      const started = Date.now();
      const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
      ], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      const diagnostic = JSON.stringify({ stage: 'invalid-audit-input', elapsedMs: Date.now() - started, status: result.status, signal: result.signal, spawnFailed: Boolean(result.error) });
      assert.ok(!result.error, diagnostic);
      assert.equal(result.status, 1, diagnostic);
      assert.ok(result.stdout.trim() === 'AUDIT_INPUT_REJECTED', diagnostic);
      assert.ok(result.stderr.trim() === '', diagnostic);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows environment keeps startup directories but excludes unrelated secrets", { skip: process.platform !== "win32" }, () => {
  const secretKey = "COMMAND_BRIDGE_ENV_TEST_SECRET";
  const saved = process.env[secretKey];
  process.env[secretKey] = "must-not-inherit";
  try {
    const environment = buildChildEnvironment([]);
    for (const name of ["SystemRoot", "SystemDrive", "ProgramFiles", "ProgramData", "LOCALAPPDATA", "APPDATA"]) {
      const actual = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
      if (actual) assert.equal(environment[actual], process.env[actual]);
    }
    assert.equal(environment[secretKey], undefined);
    assert.equal(buildChildEnvironment([secretKey])[secretKey], "must-not-inherit");
  } finally {
    if (saved === undefined) delete process.env[secretKey]; else process.env[secretKey] = saved;
  }
});

test("fixed Windows wrapper uses built-in modules and rejects arbitrary commands and arguments", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "command-bridge-ps-wrapper-"));
  const marker = join(directory, "unexpected-module.txt");
  try {
    const module = join(directory, "Microsoft.PowerShell.Utility");
    mkdirSync(module);
    writeFileSync(join(module, "Microsoft.PowerShell.Utility.psm1"), `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'unexpected'); throw 'Unexpected module loaded'`);
    const run = (name: string, args: string[]) => {
      const environment = buildChildEnvironment([]);
      environment.PSModulePath = directory;
      environment.COMMAND_BRIDGE_CMDLET_REQUEST = Buffer.from(JSON.stringify({ name, args })).toString("base64");
      return spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/windows/run-cmdlet.ps1")], { env: environment, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
    };
    const normal = run("Microsoft.PowerShell.Utility\\Get-Date", []);
    assert.equal(normal.status, 0, JSON.stringify({ error: normal.error?.message, stderr: normal.stderr }));
    assert.ok(normal.stdout.trim().length > 0);
    for (const name of ["Microsoft.PowerShell.Management\\Get-Service", "CimCmdlets\\Get-CimInstance"]) {
      const result = run(name, []);
      assert.equal(result.status, 0, JSON.stringify({ name, error: result.error?.message, stderr: result.stderr }));
      assert.ok(result.stdout.trim().length > 0);
    }
    const unknown = run("Microsoft.PowerShell.Utility\\Write-Output", ["unexpected"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown built-in cmdlet/);
    const injected = run("Microsoft.PowerShell.Utility\\Get-Date", ["; Write-Output unexpected"]);
    assert.notEqual(injected.status, 0);
    assert.match(injected.stderr, /Cmdlet arguments rejected/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows file Audit protects existing files without loading caller PowerShell modules", { skip: process.platform !== "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-audit-module-"));
  const marker = join(directory, "unexpected-module.txt"), saved = process.env.PSModulePath;
  try {
    const module = join(directory, "Microsoft.PowerShell.Utility"); mkdirSync(module);
    writeFileSync(join(module, "Microsoft.PowerShell.Utility.psm1"), `function New-Object { [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'unexpected'); throw 'Caller module loaded' }`);
    process.env.PSModulePath = directory;
    const audit = new FileAuditLog(join(directory, "audit"));
    for (const phase of ["attempted", "completed"] as const) await audit.write(createAuditEvent({ command: "echo 中文🙂", phase, executionMode: "unrestricted", source: "stdio" }));
    const events = await audit.list(2);
    assert.deepEqual(events.events.map(event => event.phase), ["completed", "attempted"]);
    assert.equal(events.events[0]!.command, "echo 中文🙂");
    assert.equal(existsSync(marker), false);
  } finally {
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});
