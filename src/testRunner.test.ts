import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("test runner serializes recursive discovery and propagates a real test failure", () => {
  const runner = resolve("scripts/test.mjs");
  const root = mkdtempSync(join(tmpdir(), "cb-test-runner-"));
  const events = join(root, "events.txt"), lease = join(root, "active");
  const env = { ...process.env };
  // This is a new test-runner process, not another child of the outer harness.
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [runner], {
    cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024
  });
  try {
    writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}');
    mkdirSync(join(root, "dist", "nested"), { recursive: true });
    // Two actual test processes compete for one exclusive directory. Parallel
    // execution fails with EEXIST; neither process touches a host deployment.
    const fixture = [
      'import test from "node:test";',
      'import { mkdirSync, appendFileSync, rmdirSync } from "node:fs";',
      'import { setTimeout } from "node:timers/promises";',
      `test("private exclusive fixture", async () => {`,
      `  mkdirSync(${JSON.stringify(lease)});`,
      `  try { appendFileSync(${JSON.stringify(events)}, "begin\\n"); await setTimeout(500); }`,
      `  finally { appendFileSync(${JSON.stringify(events)}, "end\\n"); rmdirSync(${JSON.stringify(lease)}); }`,
      '});'
    ].join("\n");
    writeFileSync(join(root, "dist", "first.test.js"), fixture);
    writeFileSync(join(root, "dist", "nested", "second.test.js"), fixture);
    writeFileSync(join(root, "dist", "ignored.js"), 'throw new Error("Non-test file was executed");');
    const passed = run();
    assert.equal(passed.status, 0, "Sequential test runner failed: " + passed.stdout + passed.stderr + (passed.error ?? ""));
    assert.equal(existsSync(lease), false);
    assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), ["begin", "end", "begin", "end"]);

    writeFileSync(join(root, "dist", "failure.test.js"), [
      'import test from "node:test";', 'import assert from "node:assert/strict";',
      'test("private failure", () => assert.fail("expected fixture failure"));'
    ].join("\n"));
    const failed = run();
    assert.equal(failed.status, 1, "Runner did not preserve a failed test exit code.");
    assert.match(failed.stdout + failed.stderr, /expected fixture failure/);
    assert.equal(existsSync(lease), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
