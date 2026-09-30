import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("deployment copy failures remove only this install's staging directories", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("bash", ["scripts/linux-systemd/tests/cleanup.test.sh"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});

test("README Linux commands remove downloaded scripts on success and failure", { skip: process.platform !== "linux" }, () => {
  const work = mkdtempSync(join(tmpdir(), "command-bridge-command-cleanup-"));
  try {
    const bin = join(work, "bin"), temporary = join(work, "temporary");
    mkdirSync(bin); mkdirSync(temporary);
    for (const [name, content] of [
      ["curl", '#!/bin/bash\nwhile (($#)); do if [[ "$1" == -o ]]; then shift; printf partial > "$1"; fi; shift; done\nexit "${DOWNLOAD_STATUS:-0}"\n'],
      ["sudo", '#!/bin/bash\nexit "${INSTALL_STATUS:-0}"\n']
    ]) { const file = join(bin, name!); writeFileSync(file, content!); chmodSync(file, 0o755); }
    for (const document of ["README.md", "README.zh-TW.md", "docs/linux-systemd.md"]) {
      const commands = readFileSync(document, "utf8").split(/\r?\n/).filter(line => line.startsWith("(") && line.includes("bootstrap.sh"));
      assert.ok(commands.length >= 2, document);
      for (const command of commands) for (const [download, install, expected] of [[0, 0, 0], [22, 0, 22], [0, 31, 31]]) {
        const result = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 5_000, env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
          DOWNLOAD_STATUS: String(download), INSTALL_STATUS: String(install)
        } });
        assert.equal(result.status, expected, result.stderr);
        assert.deepEqual(readdirSync(temporary), [], `${document}: ${command}`);
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
