import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const installer = readFileSync(
  resolve(projectRoot, "scripts/linux-systemd/install.sh"),
  "utf8"
);
const uninstaller = readFileSync(
  resolve(projectRoot, "scripts/linux-systemd/uninstall.sh"),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf8")
) as {
  version: string;
  scripts: { test: string };
};
const ciWorkflow = readFileSync(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8");
const documentation = [
  readFileSync(resolve(projectRoot, "README.md"), "utf8"),
  readFileSync(resolve(projectRoot, "README.zh-TW.md"), "utf8"),
  readFileSync(resolve(projectRoot, "docs/linux-systemd.md"), "utf8")
];

test("uninstaller is restricted to the installed CommandBridge resources", () => {
  assert.match(
    uninstaller,
    /readonly INSTALL_ROOT="\/opt\/command-bridge-mcp-server"/
  );
  assert.match(
    uninstaller,
    /readonly CONFIG_DIR="\/etc\/command-bridge-mcp-server"/
  );
  assert.match(
    uninstaller,
    /readonly STATE_DIR="\/var\/lib\/command-bridge-mcp-server"/
  );
  assert.match(
    uninstaller,
    /readonly UNIT_FILE="\/etc\/systemd\/system\/\$\{SERVICE_NAME\}\.service"/
  );
  assert.match(
    uninstaller,
    /case "\$1" in\s+"\$\{INSTALL_ROOT\}" \| "\$\{CONFIG_DIR\}" \| "\$\{STATE_DIR\}" \| "\$\{SERVICE_HOME\}"/
  );
  assert.doesNotMatch(uninstaller, /\beval\b/);
});

test("uninstaller removes the restricted audit reader and sudoers entry", () => {
  assert.match(
    uninstaller,
    /readonly AUDIT_READER_DIR="\/usr\/local\/libexec\/command-bridge-mcp-server"/
  );
  assert.match(
    uninstaller,
    /readonly AUDIT_READER_PATH="\$\{AUDIT_READER_DIR\}\/audit-reader"/
  );
  assert.match(
    uninstaller,
    /readonly AUDIT_SUDOERS_FILE="\/etc\/sudoers\.d\/command-bridge-mcp-server-audit-reader"/
  );
  assert.match(uninstaller, /remove_audit_access\(\)/);
  assert.match(
    uninstaller,
    /for path in "\$\{AUDIT_SUDOERS_FILE\}" "\$\{AUDIT_READER_PATH\}"; do/
  );
  assert.match(uninstaller, /run_command rm -f -- "\$\{path\}"/);
  assert.match(uninstaller, /rmdir -- "\$\{AUDIT_READER_DIR\}"/);

  const main = uninstaller.slice(uninstaller.indexOf("main() {"));
  const serviceRemovalIndex = main.indexOf("stop_disable_and_remove_service");
  const auditRemovalIndex = main.indexOf("remove_audit_access");
  const applicationRemovalIndex = main.indexOf('remove_tree "${INSTALL_ROOT}"');

  assert.ok(serviceRemovalIndex < auditRemovalIndex);
  assert.ok(auditRemovalIndex < applicationRemovalIndex);
});

test("default uninstall preserves configuration data and service identity", () => {
  assert.match(uninstaller, /^PURGE=0$/m);
  assert.match(
    uninstaller,
    /Without --purge, the uninstaller preserves:[\s\S]*\/etc\/command-bridge-mcp-server[\s\S]*\/var\/lib\/command-bridge-mcp-server[\s\S]*command-bridge service account and group/
  );

  const main = uninstaller.slice(uninstaller.indexOf("main() {"));
  assert.match(
    main,
    /remove_tree "\$\{INSTALL_ROOT\}"\s+if \[\[ "\$\{PURGE\}" == "1" \]\]; then\s+remove_service_identity\s+remove_tree "\$\{CONFIG_DIR\}"\s+remove_tree "\$\{STATE_DIR\}"\s+remove_tree "\$\{SERVICE_HOME\}"\s+fi/
  );
});

test("purge and non-interactive execution require explicit flags", () => {
  assert.match(uninstaller, /--yes \| -y\)\s+ASSUME_YES=1/);
  assert.match(uninstaller, /--purge\)\s+PURGE=1/);
  assert.match(
    uninstaller,
    /Interactive confirmation is unavailable\. Re-run with --yes after reviewing the plan\./
  );
  assert.match(
    uninstaller,
    /--purge permanently deletes the bearer token and all CommandBridge work data\./
  );
});

test("purge validates the dedicated identity and never kills its processes", () => {
  const main = uninstaller.slice(uninstaller.indexOf("main() {"));
  const stopIndex = main.indexOf("stop_disable_and_remove_service");
  const validationIndex = main.indexOf("validate_service_identity_for_purge");
  const applicationRemovalIndex = main.indexOf('remove_tree "${INSTALL_ROOT}"');
  const identityRemovalIndex = main.indexOf("remove_service_identity");

  assert.notEqual(stopIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.notEqual(applicationRemovalIndex, -1);
  assert.notEqual(identityRemovalIndex, -1);
  assert.ok(stopIndex < validationIndex);
  assert.ok(validationIndex < applicationRemovalIndex);
  assert.ok(applicationRemovalIndex < identityRemovalIndex);
  assert.match(uninstaller, /account_uid}" != "0"/);
  assert.match(uninstaller, /account_home}" == "\$\{SERVICE_HOME\}"/);
  assert.match(uninstaller, /all_groups}" == "\$\{SERVICE_GROUP\}"/);
  assert.match(uninstaller, /pgrep -u "\$\{account_uid\}"/);
  assert.doesNotMatch(uninstaller, /\bpkill\b|\bkill\b/);
});

test("installer and uninstaller serialize through the same lock", () => {
  assert.match(installer, /readonly LOCK_DIR="\/run\/command-bridge-mcp-server"/);
  assert.match(installer, /exec 9>"\$\{LOCK_DIR\}\/install\.lock"/);
  assert.match(uninstaller, /readonly LOCK_DIR="\/run\/command-bridge-mcp-server"/);
  assert.match(uninstaller, /readonly LOCK_FILE="\$\{LOCK_DIR\}\/install\.lock"/);
  assert.match(uninstaller, /flock -n 9/);
});

test("uninstaller supports a no-change dry run", () => {
  assert.match(uninstaller, /--dry-run\)\s+DRY_RUN=1/);
  assert.match(uninstaller, /\[dry-run\]/);
  assert.match(uninstaller, /Dry run complete; no changes were made\./);
});

test("release documentation pins uninstall commands to the package version", () => {
  for (const document of documentation) {
    assert.match(
      document,
      new RegExp(
        `https://raw\\.githubusercontent\\.com/HsinPu/command-bridge-mcp-server/v${packageJson.version}/scripts/linux-systemd/uninstall\\.sh`
      )
    );
    assert.match(document, /--purge --yes/);
  }
});

test("test and CI commands include the uninstall assets", () => {
  assert.match(packageJson.scripts.test, /dist\/uninstallAssets\.test\.js/);
  assert.match(
    ciWorkflow,
    /bash -n scripts\/linux-systemd\/install\.sh scripts\/linux-systemd\/uninstall\.sh packaging\/linux\/audit-reader/
  );
  assert.match(ciWorkflow, /Check Windows installer assets/);
});
