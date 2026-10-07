import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { version } from "./version.js";

const projectRoot = process.cwd();
test("SELinux deployment repairs reused runtimes and fails closed before activation", {
  skip: process.platform !== "linux"
}, () => {
  const result = spawnSync("bash", ["scripts/linux-systemd/tests/selinux.test.sh"], {
    encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});
test("installer-account switch preserves configuration and Audit rollback", {
  skip: process.platform !== "linux"
}, () => {
  const result = spawnSync("bash", ["scripts/linux-systemd/tests/installer-account.test.sh"], {
    encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});
const bash = process.platform === "win32"
  ? resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
  : "bash";
test("Linux automatic IP setup selects private interfaces and preserves explicit URLs", {
  skip: process.platform === "win32" && !existsSync(bash)
}, () => {
  const result = spawnSync(bash, ["scripts/linux-systemd/tests/install.test.sh"], {
    encoding: "utf8", windowsHide: true, timeout: 30_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
});
const installer = readFileSync(
  resolve(projectRoot, "scripts/linux-systemd/install.sh"),
  "utf8"
);
const unit = readFileSync(
  resolve(projectRoot, "packaging/systemd/command-bridge.service")
);
const installerUnit = readFileSync(resolve(projectRoot, "packaging/systemd/command-bridge-installer.service"));
const auditReader = readFileSync(resolve(projectRoot, "packaging/linux/audit-reader"));
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

test("installer pins the opt-in login-account systemd unit digest", () => {
  const configuredDigest = /readonly INSTALLER_UNIT_SHA256="([a-f0-9]{64})"/.exec(installer)?.[1];
  assert.equal(configuredDigest, createHash("sha256").update(installerUnit).digest("hex"));
});

test("installer pins and deploys the fixed Linux audit reader", () => {
  const configuredDigest = /readonly AUDIT_READER_SHA256="([a-f0-9]{64})"/.exec(installer)?.[1];
  const actualDigest = createHash("sha256").update(auditReader).digest("hex");

  assert.equal(configuredDigest, actualDigest);
  assert.match(installer, /readonly AUDIT_READER_PATH="\$\{AUDIT_READER_DIR\}\/audit-reader"/);
  assert.match(
    installer,
    /readonly AUDIT_SUDOERS_FILE="\/etc\/sudoers\.d\/command-bridge-audit-reader"/
  );
  assert.match(installer, /packaging\/linux\/audit-reader/);
  assert.match(installer, /install -m 0755 -o root -g root "\$\{TEMP_DIR\}\/audit-reader"/);
  assert.match(installer, /printf '%s ALL=\(root\) NOPASSWD: %s ""\\n' \\/);
  assert.match(
    installer,
    /"\$\{SERVICE_USER\}" "\$\{AUDIT_READER_PATH\}" > "\$\{sudoers_staging\}"/
  );
  assert.match(installer, /visudo -cf "\$\{AUDIT_SUDOERS_FILE\}"/);
  assert.match(installer, /runuser -u "\$\{SERVICE_USER\}" -- \/usr\/bin\/sudo -n "\$\{AUDIT_READER_PATH\}"/);
  assert.match(auditReader.toString("utf8"), /set -euo pipefail/);
  assert.match(auditReader.toString("utf8"), /--unit command-bridge\.service/);
  assert.match(auditReader.toString("utf8"), /--output=cat/);
  assert.match(auditReader.toString("utf8"), /--lines=1001/);
  assert.match(auditReader.toString("utf8"), /\/usr\/bin\/awk/);
});

test("Linux audit reader accepts empty journals, filters logs, and propagates read errors", {
  skip: process.platform !== "linux"
}, () => {
  const directory = mkdtempSync(resolve(tmpdir(), "audit-reader-test-"));
  try {
    const journal = resolve(directory, "journalctl");
    const helper = resolve(directory, "reader");
    writeFileSync(helper, auditReader.toString("utf8").replace("/usr/bin/journalctl", journal));
    const event = '{"schemaVersion":1,"event":"command_bridge.audit","id":"test"}';
    for (const scenario of [
      { body: "exit 0", status: 0, output: "" },
      { body: `printf '%s\\n' 'ordinary log' '${event}' 'other log'`, status: 0, output: event + "\n" },
      { body: "echo 'journal unavailable' >&2; exit 7", status: 7, output: "" },
      { body: `case " $* " in *" --lines=1001 "*) ;; *) exit 9;; esac; i=0; while [ "$i" -lt 1001 ]; do printf '%s\\n' '${event}'; i=$((i+1)); done`, status: 0, output: (event + "\n").repeat(1001) }
    ]) {
      writeFileSync(journal, "#!/bin/sh\n" + scenario.body + "\n", { mode: 0o700 });
      const result = spawnSync("bash", [helper], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, scenario.status, result.stderr);
      assert.equal(result.stdout, scenario.output);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installer identifies source by SHA independently from package version", () => {
  assert.match(installer, /\.command-bridge-source-sha/);
  assert.doesNotMatch(installer, /refs\/tags|readonly SOURCE_REF="v/);
  assert.match(installer, /release_name="v\$\{package_version\}-\$\{SOURCE_REF\}"/);
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
  assert.equal(version, packageJson.version);
});

test("systemd unit uses the versioned application and runtime symlinks", () => {
  const unitText = unit.toString("utf8");

  assert.match(
    unitText,
    /ExecStart=\/usr\/local\/lib\/command-bridge\/runtime\/current\/bin\/node \/usr\/local\/lib\/command-bridge\/current\/dist\/index\.js/
  );
  assert.match(unitText, /User=command-bridge/);
  assert.match(unitText, /NoNewPrivileges=false/);
  assert.match(unitText, /^CapabilityBoundingSet=CAP_SETUID CAP_SETGID$/m);
  assert.match(unitText, /^AmbientCapabilities=$/m);
  assert.match(unitText, /^DevicePolicy=closed$/m);
  assert.doesNotMatch(unitText, /^(PrivateDevices|ProtectHostname|ProtectClock|ProtectKernelTunables|ProtectKernelModules|ProtectKernelLogs|RestrictRealtime|RestrictNamespaces|LockPersonality|SystemCallArchitectures|RestrictAddressFamilies)=/m);
  assert.doesNotMatch(unitText, /RestrictSUIDSGID=true/);
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
  assert.match(installer, /CODEX_SETUP_URL=\$\(automatic_codex_url\)/);
  assert.doesNotMatch(installer, /REPLACE_WITH_PRIVATE_HOSTNAME/);
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
    /bearer_token_env_var.*token_env/
  );
  assert.match(setupFunction, /\[mcp_servers\.\$\{connection_name\}\]/);
  assert.match(setupFunction, /Never overwrite the existing connection or its token/);
  assert.match(setupFunction, /Do not repeat the bearer token in your final response/);
  assert.doesNotMatch(setupFunction, /^bearer_token\s*=/m);
});

test("installation documentation enables the copy-ready Codex setup block", () => {
  for (const document of documentation) {
    assert.match(document, /--print-codex-setup/);
  }
});
