import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGuardedCommand } from "./guardedPolicy.js";
import { CommandExecutor } from "./commandExecutor.js";
import { toErrorPayload } from "../errors/AppError.js";
import { createAuditEvent, parseWindowsEventLogLines, type AuditLog, type CommandAuditEvent } from "./auditLog.js";
import type { AppConfig } from "../config/env.js";
import { loadConfig } from "../config/env.js";

test("guarded configuration is explicit and does not require allowlist profiles", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    assert.equal(loadConfig().executionMode, "allowlist");
    process.env.COMMAND_BRIDGE_EXECUTION_MODE = "guarded";
    process.env.COMMAND_BRIDGE_ALLOWED_COMMANDS = "unknown-native-tool";
    assert.equal(loadConfig().executionMode, "guarded");
    assert.equal(loadConfig().fileTransfer?.upload, false);
    process.env.COMMAND_BRIDGE_EXECUTION_MODE = "invalid";
    assert.throws(loadConfig, /configuration/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("guarded rejects direct deletion including sudo, pipes and synchronization options", () => {
  for (const command of ["sudo -n /bin/rm -- /tmp/a", "hostname && unlink /tmp/a", "cat /tmp/a | rm /tmp/b", "find /tmp -delete", "rsync --delete-after /tmp/a /tmp/b", "rsync --remove-source-files a b", "robocopy a b /MIR", "Remove-Item -LiteralPath C:\\temp\\a", "cmd /c 'del C:\\temp\\a'", "sudo bash -c 'rm /tmp/a'"])
    assert.throws(() => assertGuardedCommand(command, "/tmp", { platform: "linux" }), { code: "DELETE_OPERATION_BLOCKED" }, command);
});

test("guarded distinguishes system queries from modifications on both platforms", () => {
  for (const command of ["sudo systemctl restart tomcat", "systemctl enable tomcat", "dnf install nodejs", "apt-get update", "rpm -e example", "dpkg --remove example", "useradd alice", "ip route add default via 10.0.0.1", "firewall-cmd --add-port=8800/tcp", "iptables -A INPUT -j ACCEPT", "nft flush ruleset", "sysctl -w net.ipv4.ip_forward=1", "shutdown -h now", "mount /dev/a /mnt", "sudo tee /etc/a", "echo x > /etc/a", "cp /tmp/a /usr/local/bin/a", "mv /etc/a /tmp/a", "sed -i 's/a/b/' /etc/a", "dd if=/tmp/a of=/dev/sda", "crontab /tmp/a"])
    assert.throws(() => assertGuardedCommand(command, "/tmp", { platform: "linux" }), { code: "SYSTEM_MODIFICATION_BLOCKED" }, command);
  for (const command of ["cat /etc/passwd | head -n 5", "sudo -n journalctl -n 10", "systemctl status tomcat", "dnf list installed", "rpm -qa", "dpkg -l", "ip route show", "firewall-cmd --list-all", "iptables -L", "nft list ruleset", "sysctl net.ipv4.ip_forward", "crontab -l", "cp /etc/passwd /tmp/copy", "echo hello > /tmp/work.txt", "mkdir /tmp/new", "echo 'rm /tmp/a'"])
    assert.doesNotThrow(() => assertGuardedCommand(command, "/tmp", { platform: "linux" }), command);
  const cfg = { platform: "win32" as const, systemPaths: ["C:\\Windows", "C:\\Program Files"] };
  for (const command of ['Set-Content "c:\\WINDOWS\\test.txt" -Value x', 'Copy-Item C:\\temp\\a "C:\\Program Files\\a"', 'Set-ItemProperty HKLM:\\Software\\Example -Name a -Value b', 'reg add HKCU\\Software\\Example /v a /d b', 'sc config Tomcat start= disabled', 'Restart-Service Tomcat', 'netsh advfirewall set allprofiles state off', 'schtasks /create /tn example', 'winget install example'])
    assert.throws(() => assertGuardedCommand(command, "C:\\temp", cfg), { code: "SYSTEM_MODIFICATION_BLOCKED" }, command);
  for (const command of ['Get-Content C:\\Windows\\win.ini', 'Set-Content C:\\temp\\a -Value test', 'Get-Service Tomcat', 'reg query HKLM\\Software', 'netsh interface show interface', 'schtasks /query', 'winget list'])
    assert.doesNotThrow(() => assertGuardedCommand(command, "C:\\temp", cfg), command);
  assert.doesNotThrow(() => assertGuardedCommand('rpm -qi example', '/tmp', { platform: 'linux' }));
  assert.throws(() => assertGuardedCommand('powershell -Command Set-Content "C:\\Windows\\new file" -Value text', 'C:\\temp', cfg), { code: 'SYSTEM_MODIFICATION_BLOCKED' });
  assert.throws(() => assertGuardedCommand('sc "C:\\Windows\\new file" text', 'C:\\temp', cfg), { code: 'SYSTEM_MODIFICATION_BLOCKED' });
  for (const command of ['hostname new-host', 'route add default gw 10.0.0.1', 'curl -o /etc/new https://example.test/a', 'wget -O /usr/bin/new https://example.test/a', 'rsync /tmp/a /etc/new'])
    assert.throws(() => assertGuardedCommand(command, '/tmp', { platform: 'linux' }), { code: 'SYSTEM_MODIFICATION_BLOCKED' });
});

test("guarded refuses unsupported syntax but treats quoted text literally", () => {
  for (const command of ["echo $HOME", "echo $(hostname)", "echo `hostname`", "echo 'unclosed", "echo x & hostname", "cat <<EOF", "powershell -EncodedCommand abc", "bash -c 'bash -c bad' | echo $TARGET"])
    assert.throws(() => assertGuardedCommand(command, "/tmp", { platform: "linux" }), { code: "GUARDED_SYNTAX_UNSUPPORTED" }, command);
  assert.doesNotThrow(() => assertGuardedCommand("printf '%s' 'literal $HOME ; rm /tmp/a'", "/tmp", { platform: "linux" }));
  // Program internals are intentionally not interpreted; this is not a root sandbox.
  assert.doesNotThrow(() => assertGuardedCommand("sudo bash /tmp/external.sh", "/tmp", { platform: "linux" }));
});

test("guarded resolves relative targets and linked parents before writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-guarded-path-")); const protectedDir = join(root, "system"), work = join(root, "work");
  mkdirSync(protectedDir); mkdirSync(work);
  try {
    symlinkSync(protectedDir, join(work, "alias"), process.platform === "win32" ? "junction" : "dir");
    for (const command of ['echo x > "../system/new"', 'tee "alias/new"', 'mv ".." "other"'])
      assert.throws(() => assertGuardedCommand(command, work, { systemPaths: [protectedDir] }), { code: "SYSTEM_MODIFICATION_BLOCKED" });
    assert.doesNotThrow(() => assertGuardedCommand('echo x > "elsewhere"', work, { systemPaths: [protectedDir] }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guarded executor preserves files, Audit identity and capacity after rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "cb-guarded-exec-")), file = join(root, "sentinel"); writeFileSync(file, "unchanged");
  const events: CommandAuditEvent[] = []; const audit: AuditLog = { async write(event) { events.push(event); }, async list() { return { events, hasMore: false }; } };
  const cfg: AppConfig = { transport: "stdio", httpHost: "127.0.0.1", httpPort: 8800, allowedHosts: [], executionMode: "guarded", allowedShells: [process.platform === "win32" ? "cmd" : "sh"], allowedCommands: new Set(), allowedRoots: [root], defaultTimeoutMs: 3000, maxTimeoutMs: 3000, maxOutputChars: 1000, maxParallelCommands: 1, passthroughEnv: [] };
  const executor = new CommandExecutor(cfg, audit);
  try {
    let caught: unknown;
    try { await executor.execute({ command: `${process.platform === "win32" ? "del" : "rm"} "${file}"` }); } catch (error) { caught = error; }
    const payload = toErrorPayload(caught).error as { code: string; rule?: string; auditId?: string };
    assert.equal(payload.code, "DELETE_OPERATION_BLOCKED"); assert.equal(payload.rule, "file-deletion"); assert.equal(payload.auditId, events[0]!.auditId);
    assert.deepEqual(events.map(e => e.phase), ["attempted", "blocked"]); assert.equal(events[1]!.auditId, events[0]!.auditId); assert.equal(readFileSync(file, "utf8"), "unchanged");
    // Nonexistent absolute program paths make a parser regression harmless: no real
    // downloader or Cmdlet is run even if preflight incorrectly accepts the request.
    const target = process.platform === "win32" ? 'C:\\Windows\\cb-guarded-probe' : '/etc/cb-guarded-probe';
    for (const command of [`"${join(root, 'curl')}" -o${target} https://example.test/a`, `"${join(root, 'Copy-Item')}" -Destination "${target}" -Path "${file}"`, `"${join(root, 'Set-Content')}" -Path:"${target}" -Value text`]) {
      const offset = events.length;
      await assert.rejects(executor.execute({ command }), { code: 'SYSTEM_MODIFICATION_BLOCKED' });
      assert.deepEqual(events.slice(offset).map(e => e.phase), ['attempted', 'blocked']);
      assert.equal(events[offset]!.auditId, events[offset + 1]!.auditId);
      assert.equal(events[offset + 1]!.errorCode, 'SYSTEM_MODIFICATION_BLOCKED');
      assert.equal(readFileSync(file, 'utf8'), 'unchanged');
    }
    assert.equal((await executor.execute({ command: "echo normal | more" })).ok, true);
    cfg.executionMode = "allowlist"; await assert.rejects(executor.execute({ command: "echo normal" }), { code: "COMMAND_NOT_ALLOWED" });
    cfg.executionMode = "unrestricted"; assert.equal((await executor.execute({ command: "echo normal" })).ok, true);
  } finally { await executor.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("Audit parsers retain guarded events with existing schema", () => {
  const event = createAuditEvent({ command: "rm example", executionMode: "guarded", phase: "blocked", errorCode: "DELETE_OPERATION_BLOCKED", source: "stdio" });
  assert.equal(parseWindowsEventLogLines(JSON.stringify(event))[0]?.executionMode, "guarded");
});

test("guarded resolves compact download outputs and PowerShell named write targets", () => {
  for (const command of ['curl -o/etc/probe https://example.test/a', 'curl --output=/etc/probe https://example.test/a', 'wget -O/etc/probe https://example.test/a', 'wget --output-document=/etc/probe https://example.test/a', 'wget -P/etc https://example.test/a'])
    assert.throws(() => assertGuardedCommand(command, '/tmp', { platform: 'linux' }), { code: 'SYSTEM_MODIFICATION_BLOCKED' });
  for (const command of ['curl -o/tmp/probe https://example.test/a', 'wget -O/tmp/probe https://example.test/a'])
    assert.doesNotThrow(() => assertGuardedCommand(command, '/tmp', { platform: 'linux' }));
  const cfg = { platform: 'win32' as const, systemPaths: ['C:\\Windows'] };
  for (const command of ['Copy-Item -Destination "C:\\Windows\\new file" -Path C:\\temp\\a', 'Copy-Item -Path:C:\\temp\\a -Destination:C:\\Windows\\probe', 'Set-Content -pAtH:C:\\WINDOWS\\probe -Value text', 'Out-File -FilePath:C:\\Windows\\probe', 'Move-Item -Destination C:\\temp\\a -LiteralPath C:\\Windows\\probe'])
    assert.throws(() => assertGuardedCommand(command, 'C:\\temp', cfg), { code: 'SYSTEM_MODIFICATION_BLOCKED' }, command);
  for (const command of ['Copy-Item -Destination C:\\temp\\a -LiteralPath C:\\Windows\\win.ini', 'Set-Content -Value C:\\Windows\\text -Path:C:\\temp\\a', 'Copy-Item -Path:C:\\Windows\\win.ini -Destination:C:\\temp\\a'])
    assert.doesNotThrow(() => assertGuardedCommand(command, 'C:\\temp', cfg), command);
  assert.throws(() => assertGuardedCommand('Copy-Item -Dest C:\\temp\\a -Path C:\\temp\\b', 'C:\\temp', cfg), { code: 'GUARDED_SYNTAX_UNSUPPORTED' });
});
