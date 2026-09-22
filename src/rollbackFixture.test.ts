import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("rollback injection requires the deployed SHA and evidence cannot be omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "command-bridge-fault-"));
  const helper = resolve("scripts/tests/rollback-fixture.mjs");
  const sha = "1".repeat(40);
  const marker = join(root, "evidence.json");
  const host = "127.0.0.2";
  const execute = (path: string, args: string[] = []) => spawnSync(process.execPath, [path, ...args], { encoding: "utf8", windowsHide: true });
  try {
    mkdirSync(join(root, "scripts"));
    const snippet = execFileSync(process.execPath, ["--input-type=module", "-e", `import {faultCode} from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(faultCode(...process.argv.slice(1)));`, sha, marker, host], { encoding: "utf8", windowsHide: true });
    const script = join(root, "scripts/verify.mjs");
    const writeVerifier = (selectedHost: string) => writeFileSync(script, `const config = {COMMAND_BRIDGE_HTTP_HOST:${JSON.stringify(selectedHost)},COMMAND_BRIDGE_ALLOWED_HOSTS:${JSON.stringify(selectedHost)}};\n${snippet}`);
    writeVerifier(host);
    assert.equal(execute(script).status, 0, "Source-tree tests must not trigger injection");
    writeFileSync(join(root, "install-info.json"), JSON.stringify({ sourceSha: "2".repeat(40) }));
    assert.equal(execute(script).status, 0, "Other deployment SHA must not trigger injection");
    assert.notEqual(execute(helper, ["assert", marker, sha, "verified"]).status, 0, "Early failure without evidence must fail");
    writeFileSync(join(root, "install-info.json"), JSON.stringify({ sourceSha: sha }));
    writeVerifier("127.0.0.1");
    assert.match(execute(script).stderr, /Network refresh did not take effect/);
    assert.notEqual(execute(helper, ["assert", marker, sha, "verified"]).status, 0);
    writeVerifier(host);
    const deployed = execute(script);
    assert.notEqual(deployed.status, 0);
    assert.match(deployed.stderr, /INJECTED_POST_ACTIVATION_FAILURE/);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).host, host);
    assert.equal(execute(helper, ["assert", marker, sha, "verified"]).status, 0);
    assert.notEqual(execute(helper, ["assert", marker, "2".repeat(40), "verified"]).status, 0);
    assert.notEqual(execute(helper, ["assert", marker, sha, "started"]).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("health fixture records startup only for its deployed identity", () => {
  const root = mkdtempSync(join(tmpdir(), "command-bridge-health-fault-"));
  const helper = resolve("scripts/tests/rollback-fixture.mjs");
  const marker = join(root, "started.json");
  const sha = "2".repeat(40);
  const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "dist"));
    assert.equal(run([helper, "prepare", root, "health", sha, marker]).status, 0);
    const executable = join(root, "dist/index.mjs");
    writeFileSync(executable, readFileSync(join(root, "src/index.ts")));
    assert.notEqual(run([executable]).status, 0);
    assert.notEqual(run([helper, "assert", marker, sha, "started"]).status, 0);
    writeFileSync(join(root, "install-info.json"), JSON.stringify({ sourceSha: "1".repeat(40) }));
    assert.match(run([executable]).stderr, /Wrong test deployment/);
    assert.notEqual(run([helper, "assert", marker, sha, "started"]).status, 0);
    writeFileSync(join(root, "install-info.json"), JSON.stringify({ sourceSha: sha }));
    const started = run([executable]);
    assert.equal(started.status, 1);
    assert.match(started.stderr, /INJECTED_STARTUP_FAILURE/);
    assert.equal(run([helper, "assert", marker, sha, "started"]).status, 0);
    assert.notEqual(run([helper, "prepare", root, "health", sha, marker]).status, 0, "Stale markers must be rejected");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
