import assert from "node:assert/strict";
import test from "node:test";
import { migrateManagedJobs } from "./jobConfigurationMigration.js";
import { parseSavedConfiguration } from "./connectionSetup.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(tmpdir(), "managed-jobs");
test("managed jobs migration preserves original bytes, explicit values and is idempotent", () => {
  const original = Buffer.from('\uFEFF# private configuration\r\nCOMMAND_BRIDGE_BEARER_TOKEN="preserved-only"\r\nCOMMAND_BRIDGE_EXECUTION_MODE=guarded');
  const result = migrateManagedJobs(original, root);
  assert.deepEqual(result.subarray(0, original.length), original);
  assert.ok(result.includes(Buffer.from('\r\nCOMMAND_BRIDGE_JOBS_ENABLED=true\r\n')));
  assert.equal(parseSavedConfiguration(result).COMMAND_BRIDGE_JOBS_ROOT, root);
  assert.deepEqual(migrateManagedJobs(result, root), result);
  const disabled = Buffer.from('export COMMAND_BRIDGE_JOBS_ENABLED = "true"\nCOMMAND_BRIDGE_JOBS_ENABLED=false # administrator choice\n');
  assert.deepEqual(migrateManagedJobs(disabled, root), disabled);
  const custom = Buffer.from(`COMMAND_BRIDGE_JOBS_ENABLED=true\nCOMMAND_BRIDGE_JOBS_ROOT=${JSON.stringify(root)}\nCOMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS=1000\nCOMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS=2000\n`);
  assert.deepEqual(migrateManagedJobs(custom, root), custom);
});
test("installer migration CLI creates a private candidate without altering its source or exposing configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-job-migration-"));
  const source = join(directory, "config.env"), output = join(directory, "candidate.env");
  const original = Buffer.from('COMMAND_BRIDGE_BEARER_TOKEN=private-migration-token\r\n# original\r\n');
  writeFileSync(source, original, { mode: 0o600 });
  try {
    const result = execFileSync(process.execPath, [fileURLToPath(new URL("./jobConfigurationMigration.js", import.meta.url)), source, output, root], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.trim(), "migrated");
    assert.deepEqual(readFileSync(source), original);
    assert.equal(parseSavedConfiguration(readFileSync(output)).COMMAND_BRIDGE_JOBS_ROOT, root);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("./jobConfigurationMigration.js", import.meta.url)), source, output, root], { stdio: "pipe", timeout: 15000 }));
    assert.deepEqual(readFileSync(source), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("managed jobs migration rejects invalid settings without guessing paths or timeouts", () => {
  for (const text of ['COMMAND_BRIDGE_JOBS_ENABLED=yes', 'COMMAND_BRIDGE_JOBS_ROOT=relative', 'COMMAND_BRIDGE_JOBS_ROOT=""', 'COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS=1', 'COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS=4000000']) {
    assert.throws(() => migrateManagedJobs(Buffer.from(text), root));
  }
});
