import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("Linux bootstrap downloads one verified snapshot and fails closed on channel errors", { skip: process.platform !== "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "command-bridge-bootstrap-test-"));
  const bin = join(directory, "bin");
  const source = join(directory, "source");
  const sha = "a".repeat(40);
  try {
    mkdirSync(bin);
    mkdirSync(join(source, "scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(source, "scripts/linux-systemd/install.sh"), '#!/bin/bash\nset -eu\nroot="$(dirname "$0")/../.."\ncat "$root/.command-bridge-source-sha" "$root/.command-bridge-source-version" > "$FIXTURE/result"\n');
    execFileSync("tar", ["-czf", join(directory, "archive.tar.gz"), "-C", directory, "source"]);
    const mock = join(bin, "curl");
    writeFileSync(mock, '#!/bin/bash\nset -eu\nurl=\nout=\nwhile (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/requests"\nif [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"; else [[ "${FAIL_ARCHIVE:-0}" == 0 ]] || exit 22; cp "$FIXTURE/archive.tar.gz" "$out"; fi\n');
    chmodSync(mock, 0o755);
    const run = (extra = {}) => spawnSync("bash", [resolve("scripts/bootstrap.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: directory, ...extra } });
    writeFileSync(join(directory, "channel"), `${sha}\n1.0.0\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(directory, "result"), "utf8"), `${sha}\n1.0.0\n`);
    const requests = readFileSync(join(directory, "requests"), "utf8").trim().split("\n");
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.endsWith(`/archive/${sha}.tar.gz`));
    assert.notEqual(run({ FAIL_CHANNEL: "1" }).status, 0);
    assert.notEqual(run({ FAIL_ARCHIVE: "1" }).status, 0);
    writeFileSync(join(directory, "requests"), "");
    writeFileSync(join(directory, "channel"), "main\n1.0.0\n");
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(directory, "requests"), "utf8").trim().split("\n").length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
