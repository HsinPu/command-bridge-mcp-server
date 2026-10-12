import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isModuleEntry } from "./moduleEntry.js";
import { createClientSetup } from "./connectionSetup.js";

test("linked CLI entries execute queries and installer output without running imported modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "cb linked entry "));
  try {
    const current = join(root, "current");
    await symlink(dirname(fileURLToPath(import.meta.url)), current, process.platform === "win32" ? "junction" : "dir");
    assert.equal(isModuleEntry(import.meta.url, join(current, "moduleEntry.test.js")), true);
    assert.equal(isModuleEntry(import.meta.url, join(current, "management.js")), false);
    assert.equal(isModuleEntry(import.meta.url, join(root, "absent.js")), false);
    for (const directory of [dirname(fileURLToPath(import.meta.url)), current]) {
      const run = (file: string, args: string[]) => spawnSync(process.execPath, [join(directory, file), ...args], { encoding: "utf8", timeout: 10000 });
      const help = run("management.js", ["setup", "--help"]);
      assert.equal(help.status, 0); assert.match(help.stdout, /Usage: command-bridge/);
      const config = join(root, "config.env"), description = join(root, "client-setup.json");
      await writeFile(config, "COMMAND_BRIDGE_HTTP_HOST=127.0.0.1\nCOMMAND_BRIDGE_BEARER_TOKEN=private_fixture_token_01234567890123456789\n");
      await writeFile(description, JSON.stringify(createClientSetup(null, "fixture", {})));
      const printed = run("clientSetupInstaller.js", ["print", config, description, "hidden"]);
      assert.equal(printed.status, 0); assert.match(printed.stdout, /http:\/\/127\.0\.0\.1:8800\/mcp/);
      assert.ok(!printed.stdout.includes("private_fixture_token"));
      const invalid = run("clientSetupInstaller.js", ["invalid"]);
      assert.equal(invalid.status, 2); assert.match(invalid.stderr, /INSTALLER_HELPER_ARGUMENTS_INVALID/);
      const info = join(root, "info.json"), setup = join(root, "setup.txt"), sha = "a".repeat(40);
      await writeFile(info, JSON.stringify({ schemaVersion: 1, installed: { sourceSha: sha }, partial: false, service: { state: "running", autoStart: true } }));
      await writeFile(setup, "Token is hidden.");
      const verified = run("verifyQueries.js", [config, info, setup, sha]);
      assert.equal(verified.status, 0);
      await writeFile(setup, "");
      const rejected = run("verifyQueries.js", [config, info, setup, sha]);
      assert.equal(rejected.status, 1); assert.match(rejected.stderr, /QUERY_VERIFICATION_FAILED/);
    }
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./management.js", import.meta.url).href)}); await import(${JSON.stringify(new URL("./clientSetupInstaller.js", import.meta.url).href)});`], { encoding: "utf8", timeout: 10000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
