import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";

const projectRoot = process.cwd();
test("Windows health probe reaches the local listener with a virtual Host and unusable default proxy", {
  skip: process.platform !== "win32"
}, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "command-bridge-health-"));
  let observedHost = "";
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? "";
    response.end('{"status":"ok"}');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const script = resolve(directory, "probe.ps1");
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER, [ref]$null, [ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy('http://127.0.0.1:1')
$result = Invoke-LocalHealthRequest -Uri $env:TEST_HEALTH_URL -HostHeader 'diagnostic.local'
if ($result -ne '{"status":"ok"}') { throw 'Invalid health response.' }
`);
    const result = await new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
        windowsHide: true, timeout: 15_000,
        env: { ...process.env, TEST_INSTALLER: resolve(projectRoot, "scripts/windows/install.ps1"), TEST_HEALTH_URL: `http://127.0.0.1:${port}/health` }
      });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      child.once("error", reject);
      child.once("close", code => resolvePromise({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(observedHost, "diagnostic.local");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
test("Windows installer config, health, runtime PATH and audit checks work under StrictMode", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    resolve(projectRoot, "scripts/windows/tests/install.tests.ps1")
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, COMMAND_BRIDGE_TEST_NODE: process.execPath }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});
const installer = readFileSync(resolve(projectRoot, "scripts/windows/install.ps1"), "utf8");
const uninstaller = readFileSync(resolve(projectRoot, "scripts/windows/uninstall.ps1"), "utf8");
const writer = readFileSync(
  resolve(projectRoot, "scripts/windows/audit/write-audit-event.ps1"),
  "utf8"
);
const reader = readFileSync(
  resolve(projectRoot, "scripts/windows/audit/read-audit-events.ps1"),
  "utf8"
);
const winSwXml = readFileSync(
  resolve(projectRoot, "packaging/windows/CommandBridgeMCP.xml"),
  "utf8"
);

test("Windows installer pins the stable x64 WinSW release and verifies its digest", () => {
  assert.match(
    installer,
    /\$WinSwUrl = "https:\/\/github\.com\/winsw\/winsw\/releases\/download\/v2\.12\.0\/WinSW-x64\.exe"/
  );
  assert.match(
    installer,
    /\$WinSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"/
  );
  assert.match(installer, /Assert-Sha256 \$path \$WinSwSha256 "WinSW"/);
  assert.match(installer, /\$NodeVersion = "24\.18\.0"/);
  assert.match(installer, /\$NodeArchiveName = "node-v\$NodeVersion-win-x64\.zip"/);
  assert.match(installer, /Node\.js checksum manifest/);
});

test("Windows service XML runs the bundled runtime as LocalService", () => {
  assert.match(winSwXml, /<id>CommandBridgeMCP<\/id>/);
  assert.match(winSwXml, /<executable>%BASE%\\runtime\\node\.exe<\/executable>/);
  assert.match(winSwXml, /<workingdirectory>%BASE%\\app<\/workingdirectory>/);
  assert.match(
    winSwXml,
    /<env name="DOTENV_CONFIG_PATH" value="%ProgramData%\\CommandBridgeMCP\\command-bridge\.env"\/>/
  );
  assert.match(winSwXml, /<logpath>%ProgramData%\\CommandBridgeMCP\\logs<\/logpath>/);
  assert.match(winSwXml, /<domain>NT AUTHORITY<\/domain>[\s\S]*<user>LocalService<\/user>/);
  assert.match(winSwXml, /<startmode>Automatic<\/startmode>/);
});

test("Windows audit scripts use only the Application CommandBridgeMCP source", () => {
  assert.match(writer, /Write-EventLog -LogName "Application" -Source "CommandBridgeMCP"/);
  assert.match(writer, /COMMAND_BRIDGE_AUDIT_EVENT/);
  assert.match(writer, /"attempted"/);
  assert.match(writer, /"blocked"/);
  assert.match(writer, /"completed"/);
  assert.match(writer, /"failed"/);
  assert.match(reader, /Get-WinEvent -FilterHashtable @\{/);
  assert.match(reader, /LogName = "Application"/);
  assert.match(reader, /ProviderName = "CommandBridgeMCP"/);
  assert.match(reader, /-MaxEvents 101/);
  assert.match(reader, /\$record\.Properties\[0\]\.Value/);
  assert.doesNotMatch(reader, /Get-EventLog|wevtutil/);
});

test("Windows installer registers and verifies the Event Log audit pipeline", () => {
  assert.match(installer, /New-EventLog -LogName "Application" -Source \$EventSource/);
  assert.match(installer, /function Invoke-AuditVerification/);
  assert.match(installer, /write-audit-event\.ps1/);
  assert.match(installer, /read-audit-events\.ps1/);
  assert.match(installer, /Windows Event Log reader returned a non-CommandBridge event\./);
  assert.match(installer, /Copy-ApplicationPayload/);
  assert.match(installer, /scripts\\windows\\audit/);
  assert.match(installer, /NT AUTHORITY\\LOCAL SERVICE:\(OI\)\(CI\)RX/);
});

test("Windows installer has bounded rollback and uninstaller removes its dedicated source", () => {
  assert.match(installer, /function Rollback-Installation/);
  assert.match(installer, /\$StagingRoot/);
  assert.match(installer, /\$PreviousRoot/);
  assert.match(installer, /Move-Item -LiteralPath \$InstallRoot -Destination \$PreviousRoot/);
  assert.match(installer, /Remove-Item -LiteralPath \$PreviousRoot -Recurse -Force/);
  assert.match(installer, /if \(\$EventSourceCreated -and \[Diagnostics\.EventLog\]::SourceExists\(\$EventSource\)\)/);
  assert.match(installer, /Remove-EventLog -Source \$EventSource/);
  assert.match(uninstaller, /Remove-EventLog -Source \$EventSource/);
  assert.match(uninstaller, /\[switch\]\$Purge/);
  assert.match(uninstaller, /Preserved configuration and work data/);
  assert.match(uninstaller, /Interactive confirmation is unavailable\. Re-run with -Yes/);
});
