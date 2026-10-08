import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Linux UTF-8 reinstall edits and rollback preserve the complete configuration in both locales", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("bash", ["scripts/linux-systemd/tests/encoding.test.sh"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});

test("dotenv rejects invalid UTF-8 before permissive decoding and accepts Chinese paths with optional BOM", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-env-encoding-")), file = join(root, "中文.env");
  try {
    const module = pathToFileURL(resolve("dist/config/env.js")).href;
    const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)});process.stdout.write(process.env.COMMAND_BRIDGE_ENCODING_FIXTURE)`], {
      cwd: root, env: { ...process.env, DOTENV_CONFIG_PATH: file, DOTENV_CONFIG_ENCODING: "utf8", DOTENV_CONFIG_QUIET: "true", COMMAND_BRIDGE_ENCODING_FIXTURE: "" }, encoding: "utf8", windowsHide: true, timeout: 10_000
    });
    for (const bom of ["", "\uFEFF"]) {
      writeFileSync(file, bom + "COMMAND_BRIDGE_ENCODING_FIXTURE=中文🙂\r\n");
      // Existing environment variables keep dotenv's normal precedence.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)});process.stdout.write(process.env.COMMAND_BRIDGE_ENCODING_FIXTURE)`], {
        cwd: root, env: { ...process.env, DOTENV_CONFIG_PATH: file, DOTENV_CONFIG_ENCODING: "utf8", DOTENV_CONFIG_OVERRIDE: "true", DOTENV_CONFIG_QUIET: "true" }, encoding: "utf8", windowsHide: true, timeout: 10_000
      });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "中文🙂");
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4]), Buffer.from([0xff,0xfe,65,0]), Buffer.from([65,0])]) {
      writeFileSync(file, bytes); const result = run();
      assert.notEqual(result.status, 0); assert.match(result.stderr, /valid UTF-8/);
      assert.deepEqual(readFileSync(file), bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
