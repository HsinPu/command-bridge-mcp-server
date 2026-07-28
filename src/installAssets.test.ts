import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const installer = readFileSync(
  resolve(projectRoot, "scripts/linux-systemd/install.sh"),
  "utf8"
);
const unit = readFileSync(
  resolve(projectRoot, "packaging/systemd/command-bridge-mcp-server.service")
);
const documentation = [
  readFileSync(resolve(projectRoot, "README.md"), "utf8"),
  readFileSync(resolve(projectRoot, "README.zh-TW.md"), "utf8"),
  readFileSync(resolve(projectRoot, "docs/linux-systemd.md"), "utf8")
];

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

test("nested installer can locate a checked-out project root", () => {
  assert.match(
    installer,
    /for candidate in "\$\{script_dir\}" "\$\{script_dir\}\/\.\.\/\.\."; do/
  );
  assert.match(
    installer,
    /if \[\[ -f "\$\{candidate\}\/package\.json" && -d "\$\{candidate\}\/src" \]\]; then/
  );
  assert.match(installer, /if \[\[ "\$\{BASH_SOURCE\[0\]\}" == "\$0" \]\]; then/);
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

test("Codex setup output requires explicit opt-in and supports a private URL", () => {
  assert.match(installer, /^PRINT_CODEX_SETUP=0$/m);
  assert.match(installer, /--print-codex-setup\)\s+PRINT_CODEX_SETUP=1/);
  assert.match(installer, /--codex-url\)\s+[\s\S]*?PRINT_CODEX_SETUP=1/);
  assert.match(
    installer,
    /--codex-url must be a private HTTPS URL ending in \/mcp/
  );
  assert.match(
    installer,
    /readonly CODEX_SETUP_URL_PLACEHOLDER="https:\/\/REPLACE_WITH_PRIVATE_HOSTNAME\/mcp"/
  );
});

test("copy-ready Codex block keeps the bearer token out of config.toml", () => {
  const setupFunction = installer.slice(
    installer.indexOf("print_codex_setup() {"),
    installer.indexOf("\nmain() {")
  );

  assert.match(
    setupFunction,
    /token=\$\(read_config_value COMMAND_BRIDGE_BEARER_TOKEN\)/
  );
  assert.match(setupFunction, /\^\[A-Za-z0-9\._~-\]\{32,\}\$/);
  assert.match(setupFunction, /BEGIN COPY FOR CODEX/);
  assert.match(setupFunction, /Bearer token \(secret\): \$\{token\}/);
  assert.match(
    setupFunction,
    /bearer_token_env_var = "COMMAND_BRIDGE_BEARER_TOKEN"/
  );
  assert.match(setupFunction, /Do not repeat the bearer token in your final response/);
  assert.doesNotMatch(setupFunction, /^bearer_token\s*=/m);
});

test("installation documentation enables the copy-ready Codex setup block", () => {
  for (const document of documentation) {
    assert.match(document, /--print-codex-setup/);
    assert.match(document, /--codex-url/);
  }
});
