import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("production pruning removes development files without rewriting source manifests", { skip: !process.env.npm_execpath }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-prune-source-"));
  try {
    const pkg = { name: "cb-prune-source", version: "1.0.0", bin: { "command-bridge-mcp-server": "dist/index.js", "command-bridge": "dist/index.js" }, devDependencies: { "fixture-dev": "1.0.0" } };
    const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": pkg, "node_modules/fixture-dev": { version: "1.0.0", dev: true } } };
    const manifest = JSON.stringify(pkg, null, 2) + "\n", locked = JSON.stringify(lock, null, 2) + "\n";
    writeFileSync(join(dir, "package.json"), manifest); writeFileSync(join(dir, "package-lock.json"), locked);
    mkdirSync(join(dir, "node_modules/fixture-dev"), { recursive: true });
    writeFileSync(join(dir, "node_modules/fixture-dev/package.json"), '{"name":"fixture-dev","version":"1.0.0"}');
    const r = spawnSync(process.execPath, [process.env.npm_execpath!, "prune", "--omit=dev", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], { cwd: dir, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), manifest);
    assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), locked);
    assert.equal(existsSync(join(dir, "node_modules/fixture-dev")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
