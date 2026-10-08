import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for (const scenario of ["backup", "configuration", "restore", "retain", "uninstall"]) {
  test(`Linux installer recovery preserves originals and reports failures: ${scenario}`, { skip: process.platform !== "linux" }, () => {
    const result = spawnSync("bash", ["scripts/linux-systemd/tests/recovery.test.sh", scenario], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
  });
}

test("recovery fixture refuses missing or mismatched activation evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-recovery-boundary-"));
  const helper = resolve("scripts/tests/recovery-fixture.mjs");
  const sha = "8".repeat(40), marker = join(root, "evidence.json");
  const run = (args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  try {
    mkdirSync(join(root, "scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(root, "scripts/linux-systemd/program-migration.sh"), "commit_application_layout() {\n  printf original\n}\n");
    writeFileSync(join(root, "scripts/linux-systemd/managed-update.sh"), "restore_managed_update_assets() {\n  return 0\n}\n");
    assert.equal(run(["prepare", root, sha, marker]).status, 0);
    assert.equal(readFileSync(join(root, ".command-bridge-source-sha"), "utf8"), sha);
    assert.notEqual(run(["assert", marker, sha]).status, 0, "An installer failure without stage evidence is not recovery proof");
    for (const evidence of [{ sha, stage: "started", fault: "INJECTED_RECOVERY_FAILURE" }, { sha, stage: "verified", fault: "wrong" }, { sha: "9".repeat(40), stage: "verified", fault: "INJECTED_RECOVERY_FAILURE" }]) {
      writeFileSync(marker, JSON.stringify(evidence));
      assert.notEqual(run(["assert", marker, sha]).status, 0);
    }
    writeFileSync(marker, JSON.stringify({ sha, stage: "verified", fault: "INJECTED_RECOVERY_FAILURE" }));
    assert.equal(run(["assert", marker, sha]).status, 0);
    assert.notEqual(run(["prepare", root, sha, marker]).status, 0, "Stale evidence must be rejected before modifying sources");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery fault activates only after service verification for the exact deployed SHA", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "cb-recovery-activation-"));
  const helper = resolve("scripts/tests/recovery-fixture.mjs");
  const sha = "8".repeat(40), other = "9".repeat(40), marker = join(root, "evidence.json");
  const scriptRoot = join(root, "scripts/linux-systemd"), runtime = join(root, "runtime"), deployed = join(root, "deployed");
  try {
    mkdirSync(scriptRoot, { recursive: true }); mkdirSync(join(runtime, "bin"), { recursive: true }); mkdirSync(deployed);
    symlinkSync(process.execPath, join(runtime, "bin/node"));
    writeFileSync(join(scriptRoot, "program-migration.sh"), "commit_application_layout() {\n  printf original\n}\n");
    writeFileSync(join(scriptRoot, "managed-update.sh"), "restore_managed_update_assets() {\n  return 0\n}\n");
    const prepared = spawnSync(process.execPath, [helper, "prepare", root, sha, marker], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const commit = (source: string, active: string) => spawnSync("bash", ["-c", 'set -eu; source "$1/program-migration.sh"; SOURCE_REF=$2; ACTIVATION_STARTED=$3; RUNTIME_LINK=$4; CURRENT_LINK=$5; fail() { echo "$*" >&2; exit 1; }; commit_application_layout', "_", scriptRoot, source, active, runtime, deployed], { encoding: "utf8", timeout: 5_000 });
    for (const [source, active] of [["", "0"], [sha, "0"], [other, "1"]]) {
      assert.equal(commit(source!, active!).status, 0, "Source builds and other SHAs must not produce activation evidence");
      assert.equal(existsSync(marker), false);
    }
    writeFileSync(join(deployed, "install-info.json"), JSON.stringify({ sourceSha: other }));
    assert.notEqual(commit(sha, "1").status, 0);
    assert.equal(existsSync(marker), false, "Wrong installed metadata cannot produce proof");
    writeFileSync(join(deployed, "install-info.json"), JSON.stringify({ sourceSha: sha }));
    const activated = commit(sha, "1");
    assert.notEqual(activated.status, 0); assert.match(activated.stderr, /INJECTED_RECOVERY_FAILURE/);
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { sha, stage: "verified", fault: "INJECTED_RECOVERY_FAILURE" });
    const restore = (source: string, rollback: string) => spawnSync("bash", ["-c", 'set -eu; source "$1/managed-update.sh"; SOURCE_REF=$2; ROLLBACK_IN_PROGRESS=$3; restore_managed_update_assets', "_", scriptRoot, source, rollback], { encoding: "utf8", timeout: 5_000 });
    assert.equal(restore(other, "1").status, 0); assert.equal(restore(sha, "0").status, 0); assert.equal(restore(sha, "1").status, 91);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
