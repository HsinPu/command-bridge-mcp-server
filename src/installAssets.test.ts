import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const installer = readFileSync(resolve(projectRoot, "install.sh"), "utf8");
const unit = readFileSync(
  resolve(projectRoot, "packaging/systemd/command-bridge-mcp-server.service")
);

test("installer pins the committed systemd unit digest", () => {
  const configuredDigest = /readonly SYSTEMD_UNIT_SHA256="([a-f0-9]{64})"/.exec(installer)?.[1];
  const actualDigest = createHash("sha256").update(unit).digest("hex");

  assert.equal(configuredDigest, actualDigest);
});

test("installer source ref matches the npm package version", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8")
  ) as { version: string };
  const sourceRef = /readonly SOURCE_REF="([^"]+)"/.exec(installer)?.[1];

  assert.equal(sourceRef, `v${packageJson.version}`);
});

test("MCP server version matches the npm package version", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8")
  ) as { version: string };
  const serverSource = readFileSync(resolve(projectRoot, "src/server.ts"), "utf8");
  const serverVersion = /version: "([^"]+)"/.exec(serverSource)?.[1];

  assert.equal(serverVersion, packageJson.version);
});

test("systemd unit uses the versioned application and runtime symlinks", () => {
  const unitText = unit.toString("utf8");

  assert.match(
    unitText,
    /ExecStart=\/opt\/command-bridge-mcp-server\/runtime\/current\/bin\/node \/opt\/command-bridge-mcp-server\/current\/dist\/index\.js/
  );
  assert.match(unitText, /User=command-bridge/);
  assert.match(unitText, /NoNewPrivileges=true/);
  assert.match(unitText, /ProtectSystem=strict/);
});
