import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/tests/verify-legacy-jobs-migration.mjs");
test("legacy migration expectation accepts only exact appended defaults and preserves every original byte", async () => {
  const { verifyLegacyJobsMigration: verify } = await import(pathToFileURL(script).href);
  for (const bom of ["", "\uFEFF"]) for (const newline of ["\n", "\r\n"]) for (const final of ["", newline]) {
    const text = bom + '# 中文 retained' + newline + 'COMMAND_BRIDGE_BEARER_TOKEN=private-fixture-token' + newline + 'COMMAND_BRIDGE_EXECUTION_MODE=guarded' + final;
    const before = Buffer.from(text);
    const after = Buffer.from(text + (final ? "" : newline) + ["COMMAND_BRIDGE_JOBS_ENABLED=true", "COMMAND_BRIDGE_JOBS_ROOT='/var/lib/command-bridge-jobs'", "COMMAND_BRIDGE_JOBS_DEFAULT_TIMEOUT_MS=1800000", "COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS=3600000", ""].join(newline));
    assert.doesNotThrow(() => verify(before, after));
    for (const changed of [after.toString().replace('private-fixture-token', 'changed-token'), after.toString().replace('=guarded', '=allowlist'), after.toString().replace('=1800000', '=1000'), after.toString().replace('COMMAND_BRIDGE_JOBS_ENABLED=true', 'COMMAND_BRIDGE_JOBS_ENABLED=false'), after.toString() + 'UNRELATED=true\n']) {
      assert.throws(() => verify(before, Buffer.from(changed)), /MISMATCH/);
    }
    assert.throws(() => verify(before, before), /MISMATCH/);
    assert.throws(() => verify(after, after), /FIXTURE_INVALID/);
  }
});

test("legacy migration CLI rejects changed secrets without printing private configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-legacy-job-expectation-"));
  try {
    const before = join(directory, "before.env"), after = join(directory, "after.env");
    writeFileSync(before, 'COMMAND_BRIDGE_BEARER_TOKEN=private-fixture-token\n', { mode: 0o600 });
    writeFileSync(after, 'COMMAND_BRIDGE_BEARER_TOKEN=changed-private-token\n', { mode: 0o600 });
    const result = spawnSync(process.execPath, [script, before, after], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "LEGACY_JOBS_MIGRATION_VERIFICATION_FAILED");
    assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-token|changed-private-token/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
