import test from "node:test";
import assert from "node:assert/strict";
import { parseAuditTimeout, auditRequestTimeout } from "./auditTimeout.js";
import { loadConfig } from "./env.js";
import { auditStartupBudget } from "../cli/connectionSetup.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Windows PowerShell 5.1 invokes the real budget probe with quoted configuration paths", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "cb-budget-'space-"));
  const path = join(root, "saved config.env"), module = pathToFileURL(resolve("dist/cli/connectionSetup.js")).href;
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const script = `$result = & ${literal(process.execPath)} -e 'import(process.argv[1]).then(async m=>console.log(m.auditStartupBudget((await import(process.argv[3])).readFileSync(process.argv[2]))))' ${literal(module)} ${literal(path)} 'node:fs'; if ($LASTEXITCODE -ne 0) { exit 1 }; [Console]::Out.Write([string]$result)`;
  try {
    for (const [text, expected] of [["COMMAND_BRIDGE_TRANSPORT=http\n", "90000"], ['COMMAND_BRIDGE_AUDIT_TIMEOUT_MS="60000"\n', "150000"], ["COMMAND_BRIDGE_AUDIT_TIMEOUT_MS=60000\nCOMMAND_BRIDGE_AUDIT_TIMEOUT_MS='1000'\n", "32000"]]) {
      writeFileSync(path, text!);
      const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
      assert.equal(result.status, 0, JSON.stringify({ stage: "budget-probe", exit: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" }));
      assert.equal(result.stdout.trim(), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installer startup budget supports old files, quoted overrides and the last duplicate setting", () => {
  assert.equal(auditStartupBudget(Buffer.from("COMMAND_BRIDGE_TRANSPORT=http\n")), 90000);
  assert.equal(auditStartupBudget(Buffer.from('COMMAND_BRIDGE_AUDIT_TIMEOUT_MS="60000"\n')), 150000);
  assert.equal(auditStartupBudget(Buffer.from("COMMAND_BRIDGE_AUDIT_TIMEOUT_MS=60000\nCOMMAND_BRIDGE_AUDIT_TIMEOUT_MS='1000'\n")), 32000);
  assert.throws(() => auditStartupBudget(Buffer.from("COMMAND_BRIDGE_AUDIT_TIMEOUT_MS=\n")));
});

test("Audit defaults to thirty seconds and only accepts bounded integer overrides", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    assert.equal(parseAuditTimeout(), 30000); assert.equal(loadConfig().auditTimeoutMs, 30000);
    for (const value of ["1000", "30000", "60000"]) {
      process.env.COMMAND_BRIDGE_AUDIT_TIMEOUT_MS = value;
      assert.equal(loadConfig().auditTimeoutMs, parseAuditTimeout(value));
    }
    for (const value of ["", "0", "999", "60001", "1.5", "NaN", "Infinity", "1e4", " 30000 "]) {
      process.env.COMMAND_BRIDGE_AUDIT_TIMEOUT_MS = value;
      assert.throws(loadConfig); assert.throws(() => parseAuditTimeout(value));
    }
    assert.equal(auditRequestTimeout(30000, 300000), 380000);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
