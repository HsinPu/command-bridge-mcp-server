import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

test("Linux service entries preserve identity, fixed argv, PID and failure status", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "cb-service-entry-"));
  try {
    const script = join(root, "fixed entry.mjs");
    writeFileSync(script, [
      'if (process.env.CB_ENTRY_TEST_FAILURE === "1") process.exit(23);',
      'console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.CB_ENTRY_TEST_MARKER }));'
    ].join("\n"));
    for (const name of ["command-bridge", "command-bridge-installer", "command-bridge-update"]) {
      const unit = readFileSync(`packaging/systemd/${name}.service`, "utf8");
      const entries = unit.split(/\r?\n/).filter(line => /^Exec(Start|StopPost)=/.test(line));
      assert.equal(entries.length, name === "command-bridge-update" ? 2 : 1);
      for (const entry of entries) {
        const argv = entry.slice(entry.indexOf("=") + 1).split(" ");
        assert.deepEqual(argv.slice(0, 2), ["/usr/bin/env", "--"]);
        assert.equal(argv[2], "/usr/local/lib/command-bridge/runtime/current/bin/node");
        assert.ok(argv[3].startsWith("/usr/local/"));
        // Substitute only the deployed executable/script in a private fixture.
        argv.splice(2, 2, process.execPath, script);
        const env = { ...process.env, CB_ENTRY_TEST_MARKER: "fixed fixture marker" };
        const passed = spawnSync(argv[0], argv.slice(1), { cwd: root, env, encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
        assert.equal(passed.status, 0, "Private fixed entry failed.");
        assert.equal(passed.stderr, "");
        assert.deepEqual(JSON.parse(passed.stdout), { uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(), pid: passed.pid, argv: argv.slice(4), cwd: root, marker: env.CB_ENTRY_TEST_MARKER });
        const failed = spawnSync(argv[0], argv.slice(1), { cwd: root, env: { ...env, CB_ENTRY_TEST_FAILURE: "1" }, timeout: 5000 });
        assert.equal(failed.status, 23, "The fixed entry must preserve a real failure.");
        const missing = spawnSync(argv[0], ["--", join(root, "missing runtime")], { timeout: 5000 });
        assert.equal(missing.status, 127, "A missing Runtime must fail startup.");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Linux fixed service entry forwards termination to the tracked Node PID", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cb-service-signal-"));
  const script = join(root, "signal.mjs");
  writeFileSync(script, 'process.on("SIGTERM", () => process.exit(17)); console.log(process.pid); setInterval(() => {}, 1000);');
  const child = spawn("/usr/bin/env", ["--", process.execPath, script], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [output] = await Promise.race([
      once(child.stdout!, "data"),
      closed.then(() => { throw new Error("Private service entry exited before readiness."); })
    ]);
    assert.equal(Number(String(output).trim()), child.pid);
    assert.equal(child.kill("SIGTERM"), true);
    assert.deepEqual(await closed, [17, null]);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
