import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("update mode parsing treats configuration as data and ignores inherited modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-update-state-"));
  try {
    const config = join(dir, "config");
    for (const [text, expected] of [["", "allowlist"], ['export COMMAND_BRIDGE_EXECUTION_MODE="guarded" # comment', "guarded"], ["COMMAND_BRIDGE_EXECUTION_MODE='unrestricted'\nOTHER=$(touch sentinel)", "unrestricted"]]) {
      writeFileSync(config, text!);
      const r = spawnSync(process.execPath, [resolve("dist/updateState.js"), config], { encoding: "utf8", cwd: dir, env: { ...process.env, COMMAND_BRIDGE_EXECUTION_MODE: "invalid" } });
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), expected);
    }
    writeFileSync(config, "COMMAND_BRIDGE_EXECUTION_MODE=invalid");
    const r = spawnSync(process.execPath, [resolve("dist/updateState.js"), config], { encoding: "utf8" });
    assert.equal(r.status, 1); assert.equal(r.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Linux update pins channel SHA, checks without deployment, cleans temporary files and propagates failures", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-update-bootstrap-"));
  const app = join(dir, "app"), bin = join(dir, "bin");
  const oldSha = "a".repeat(40), newSha = "b".repeat(40);
  try {
    mkdirSync(join(app, "current"), { recursive: true }); mkdirSync(join(app, "runtime/current/bin"), { recursive: true }); mkdirSync(bin);
    symlinkSync(process.execPath, join(app, "runtime/current/bin/node"));
    writeFileSync(join(app, "current/install-info.json"), JSON.stringify({ version: "4.3.0", sourceSha: oldSha }));
    mkdirSync(join(dir, "source/scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(dir, "source/scripts/linux-systemd/install.sh"), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$@" > "$FIXTURE/args"\ncat "$(dirname "$0")/../../.command-bridge-source-sha" > "$FIXTURE/selected"\nexit "${FAIL_INSTALL:-0}"\n');
    execFileSync("tar", ["-czf", join(dir, "archive"), "-C", dir, "source"]);
    writeFileSync(join(bin, "curl"), '#!/bin/bash\nset -eu\nurl=; out=\nwhile (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/requests"\nprintf "%s\\n" "$(dirname "$out")" > "$FIXTURE/temp"\nif [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"; else [[ "${FAIL_ARCHIVE:-0}" == 0 ]] || exit 22; cp "$FIXTURE/archive" "$out"; printf "%040d\\n9.0.0\\n" 3 > "$FIXTURE/channel"; fi\n');
    chmodSync(join(bin, "curl"), 0o755);
    const bootstrap = join(dir, "bootstrap.sh");
    // All deployment paths point at the disposable fixture; privilege is mocked only here.
    writeFileSync(bootstrap, readFileSync("scripts/bootstrap.sh", "utf8").replaceAll("/opt/command-bridge", app).replace('"$EUID" != 0', '0 != 0'));
    const run = (flags: string[] = [], extra = {}) => spawnSync("bash", [bootstrap, "--update", ...flags], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: dir, ...extra }, timeout: 15_000 });
    writeFileSync(join(dir, "channel"), `${oldSha}\n4.3.0\n`);
    assert.match(run().stdout, /Already up to date/);
    writeFileSync(join(dir, "channel"), `${newSha}\n4.3.0\n`);
    assert.match(run(["--check"]).stdout, /Update available/);
    assert.throws(() => readFileSync(join(dir, "args")));
    const applied = run(["--print-codex-setup"]); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(dir, "selected"), "utf8").trim(), newSha);
    assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n"), ["--update", "--expected-installed-sha", oldSha, "--print-codex-setup"]);
    assert.throws(() => readFileSync(join(readFileSync(join(dir, "temp"), "utf8").trim(), "channel.txt")));
    writeFileSync(join(dir, "channel"), `${newSha}\n4.3.0\n`);
    assert.equal(run([], { FAIL_INSTALL: "7" }).status, 7);
    for (const extra of [{ FAIL_CHANNEL: "1" }, { FAIL_ARCHIVE: "1" }]) assert.notEqual(run([], extra).status, 0);
    assert.equal(run(["--guarded"]).status, 2);
    assert.equal(run(["--check", "--print-codex-setup"]).status, 2);
    writeFileSync(join(dir, "channel"), "main\n4.3.0\n"); assert.notEqual(run(["--check"]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Linux update preserves exact configuration and service identity, rejecting stale SHA and another account", { skip: process.platform !== "linux" }, () => {
  const r = spawnSync("bash", ["scripts/linux-systemd/tests/update.test.sh"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, TEST_NODE: process.execPath } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("Windows update wrapper/bootstrap checks, failures and deployment lock", { skip: process.platform !== "win32" }, () => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "scripts/windows/tests/update.test.ps1"], { encoding: "utf8", timeout: 25_000, windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
