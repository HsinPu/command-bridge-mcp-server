import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
test("version flags work without runtime dependencies, valid config or Audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-version-"));
  try {
    copyFileSync("dist/index.js", join(dir, "index.js"));
    copyFileSync("dist/version.js", join(dir, "version.js"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    for (const flag of ["--version", "-V"]) {
      const r = spawnSync(process.execPath, [join(dir, "index.js"), flag], { encoding: "utf8", timeout: 3_000, env: { ...process.env, COMMAND_BRIDGE_TRANSPORT: "invalid", COMMAND_BRIDGE_AUDIT_BACKEND: "invalid" } });
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), version); assert.equal(r.stderr, "");
    }
    const bad = spawnSync(process.execPath, [join(dir, "index.js"), "--version", "extra"], { encoding: "utf8", timeout: 3_000 });
    assert.equal(bad.status, 2); assert.equal(bad.stdout, "");
    assert.equal(readdirSync(dir).length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Linux installed CLI follows releases and preserves foreign entries", { skip: process.platform !== "linux" }, () => {
  const r = spawnSync("bash", ["scripts/linux-systemd/tests/cli.test.sh"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("Linux version launcher uses only its bundled runtime and handles spaces", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cb version "));
  try {
    mkdirSync(join(dir, "runtime/current/bin"), { recursive: true });
    mkdirSync(join(dir, "current/dist"), { recursive: true });
    symlinkSync(process.execPath, join(dir, "runtime/current/bin/node"));
    copyFileSync("dist/index.js", join(dir, "current/dist/index.js"));
    copyFileSync("dist/version.js", join(dir, "current/dist/version.js"));
    writeFileSync(join(dir, "current/package.json"), '{"type":"module"}');
    const path = join(dir, "command-bridge");
    writeFileSync(path, readFileSync("packaging/linux/command-bridge", "utf8").replaceAll("__INSTALL_ROOT__", dir)); chmodSync(path, 0o755);
    const r = spawnSync(path, ["-V"], { encoding: "utf8", timeout: 3_000 });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), version);
    assert.equal(spawnSync(path, [], { encoding: "utf8", timeout: 3_000 }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Windows installed launcher resolves a bundled runtime in paths with spaces", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cb version "));
  try {
    mkdirSync(join(dir, "runtime")); mkdirSync(join(dir, "app/dist"), { recursive: true });
    copyFileSync(process.execPath, join(dir, "runtime/node.exe"));
    copyFileSync("dist/index.js", join(dir, "app/dist/index.js"));
    copyFileSync("dist/version.js", join(dir, "app/dist/version.js"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const launcher = readFileSync("packaging/windows/command-bridge.cmd", "utf8").replaceAll("__APPLICATION_RELATIVE_PATH__", "app");
    writeFileSync(join(dir, "command-bridge.cmd"), launcher);
    for (const flag of ["--version", "-V"]) {
      const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${join(dir, "command-bridge.cmd")}" ${flag}"`], { encoding: "utf8", windowsHide: true, timeout: 5_000, windowsVerbatimArguments: true });
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), version);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
