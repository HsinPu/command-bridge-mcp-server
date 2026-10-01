import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoSelfModification } from "./selfProtection.js";
import { CommandExecutor } from "./commandExecutor.js";
import type { AppConfig } from "../config/env.js";
import type { AuditLog, CommandAuditEvent } from "./auditLog.js";

test("preflight blocks direct Linux self writes without blocking other sudo or reads", () => {
  const cfg = { platform: "linux" as const, protectedPaths: ["/etc/command-bridge", "/opt/command-bridge"] };
  for (const command of [
    "sudo -n rm -- /etc/command-bridge/policy.json", "sudo -u root /usr/bin/tee '/etc/command-bridge/command-bridge.env'",
    'echo allowlist > "/etc/command-bridge/command-bridge.env"', "printf text >>/etc/command-bridge/new.env",
    "sudo sed -i 's/a/b/' /etc/command-bridge/policy.json", "sudo perl -pi -e 's/a/b/' /etc/command-bridge/policy.json",
    "sudo chmod 777 /etc/command-bridge", "sudo chown -R nobody /etc/command-bridge", "sudo mv /etc /tmp/old-etc",
    "sudo cp /tmp/new.env /etc/command-bridge/command-bridge.env", "sudo dd if=/tmp/new of=/etc/command-bridge/policy.json",
    "sudo rm -rf /opt/command-bridge*", "sudo bash -c 'echo x > /etc/command-bridge/new.env'",
    "hostname && sudo rm /etc/command-bridge/policy.json", "sudo systemctl edit command-bridge.service"
  ]) assert.throws(() => assertNoSelfModification(command, "/tmp", cfg), { code: "SELF_MODIFICATION_BLOCKED" }, command);
  for (const command of ["sudo -n rm -- /tmp/pdks.jar", "sudo chmod 600 /tmp/a", "sudo sed -i 's/a/b/' /tmp/a",
    "cat /etc/command-bridge/policy.json", "cat /etc/command-bridge/policy.json 2>&1", "cat /etc/command-bridge/policy.json; rm /tmp/a",
    "sudo rm /etc/command-bridge-backup/a", "sudo systemctl restart tomcat", "sudo systemctl restart command-bridge",
    "echo 'rm /etc/command-bridge/policy.json'", "sudo id -u"])
    assert.doesNotThrow(() => assertNoSelfModification(command, "/opt/command-bridge", cfg), command);
});

test("preflight resolves relative paths, linked parents and targets not yet created", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-self-"));
  const config = join(root, "config"), work = join(root, "work");
  mkdirSync(config); mkdirSync(work);
  try {
    symlinkSync(config, join(work, "alias"), process.platform === "win32" ? "junction" : "dir");
    const cfg = { protectedPaths: [config] };
    for (const command of ['rm "../config/new.env"', 'tee "alias/new.env"', 'mv ".." outside'])
      assert.throws(() => assertNoSelfModification(command, work, cfg), { code: "SELF_MODIFICATION_BLOCKED" });
    assert.doesNotThrow(() => assertNoSelfModification('rm "elsewhere/new.env"', work, cfg));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight covers Windows case, quoted paths, direct Cmdlets and service edits", () => {
  const cfg = { platform: "win32" as const, protectedPaths: ["C:\\Program Files\\CommandBridgeMCP", "C:\\ProgramData\\CommandBridgeMCP\\command-bridge.env"] };
  for (const command of [
    'Remove-Item "c:\\PROGRAM FILES\\CommandBridgeMCP\\app\\package.json"',
    'Set-Content -Path "C:\\ProgramData\\CommandBridgeMCP\\command-bridge.env" -Value test',
    'echo test > "C:\\ProgramData\\CommandBridgeMCP\\command-bridge.env"',
    'sc.exe config CommandBridgeMCP start= disabled', 'Set-Service -Name CommandBridgeMCP -StartupType Disabled',
    'del "..\\CommandBridgeMCP\\app\\package.json"'
  ]) assert.throws(() => assertNoSelfModification(command, "C:\\Program Files\\Other", cfg), { code: "SELF_MODIFICATION_BLOCKED" });
  assert.doesNotThrow(() => assertNoSelfModification('Set-Content -Path "C:\\temp\\a" -Value test', "C:\\Program Files\\CommandBridgeMCP", cfg));
  assert.doesNotThrow(() => assertNoSelfModification('Get-Content "C:\\ProgramData\\CommandBridgeMCP\\command-bridge.env"', "C:\\temp", cfg));
});

test("executor blocks a self write before spawn and records exactly attempted/blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "cb-self-executor-")), path = join(root, "policy.json");
  writeFileSync(path, "unchanged");
  const events: CommandAuditEvent[] = [];
  const audit: AuditLog = { async write(event) { events.push(event); }, async list() { return { events, hasMore: false }; } };
  const cfg: AppConfig = { transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: "unrestricted",
    allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(), allowedRoots: [root],
    defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [], policyFile: path };
  const executor = new CommandExecutor(cfg, audit);
  try {
    await assert.rejects(executor.execute({ command: 'echo changed > "' + path + '"' }), { code: "SELF_MODIFICATION_BLOCKED" });
    assert.equal(readFileSync(path, "utf8"), "unchanged");
    assert.deepEqual(events.map(e => e.phase), ["attempted", "blocked"]);
    assert.equal(events[1]!.auditId, events[0]!.auditId);
    assert.equal(events[1]!.errorCode, "SELF_MODIFICATION_BLOCKED");
    assert.equal((await executor.execute({ command: "echo allowed" })).ok, true);
  } finally { await executor.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("preflight explicitly does not inspect external scripts or variable expansion", () => {
  const cfg = { platform: "linux" as const, protectedPaths: ["/etc/command-bridge"] };
  assert.doesNotThrow(() => assertNoSelfModification("sudo bash /tmp/script.sh", "/tmp", cfg));
  assert.doesNotThrow(() => assertNoSelfModification('sudo tee "$TARGET"', "/tmp", cfg));
});
