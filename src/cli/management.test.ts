import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientSetup, parseClientSetup, resolveConnection, renderCodexSetup } from "./connectionSetup.js";
import { parseManagementArgs, runInstalledManagement, type InstallationPaths, type ManagementDependencies } from "./management.js";
import { runClientSetupInstaller } from "./clientSetupInstaller.js";
import { readRecord, assertAdminPath } from "./managedFiles.js";
import { parseLinuxService, runServiceQuery, queryService } from "./serviceStatus.js";
import { verifyQueries } from "./verifyQueries.js";

const token = "private_test_token_0123456789_abcdefghijklmnopqrstuvwxyz";
const sha = "a".repeat(40);
const version = "6.1.0";
async function fixture(platform: "linux" | "win32" = "win32") {
  const root = await mkdtemp(join(tmpdir(), "cb management 中文 "));
  const release = join(root, "releases", `v${version}-${sha}`);
  await mkdir(release, { recursive: true }); await mkdir(join(root, "runtime"));
  const paths: InstallationPaths = { platform, root, release, runtime: join(root, "runtime"),
    config: join(root, "command-bridge.env"), description: join(root, "client-setup.json"), info: join(release, "install-info.json"),
    current: platform === "linux" ? join(root, "current") : join(root, "install-info.json") };
  const info = JSON.stringify({ version, sourceSha: sha, runtimeVersion: "24.18.0" });
  await writeFile(paths.info, info);
  await writeFile(join(release, ".command-bridge-release"), sha + "\n");
  if (platform === "linux") await symlink(release, paths.current); else await writeFile(paths.current, info);
  await writeFile(paths.config, `\ufeff# 中文\r\nCOMMAND_BRIDGE_BEARER_TOKEN=${token}\r\nCOMMAND_BRIDGE_HTTP_HOST=::1\r\nCOMMAND_BRIDGE_HTTP_PORT=8800\r\nCOMMAND_BRIDGE_EXECUTION_MODE=guarded\r\nCOMMAND_BRIDGE_AUDIT_BACKEND=file\r\nCOMMAND_BRIDGE_ALLOWED_ROOTS=${platform === "win32" ? "C:\\工作 目錄" : "/工作 目錄"}\r\n`);
  const deps: ManagementDependencies = { hostname: () => "HOST.Test", trust: async () => {}, expectedVersion: version,
    service: async () => ({ state: "running", autoStart: true, account: platform === "win32" ? "NT AUTHORITY\\LocalService" : "installer", administrator: false,
      programTrusted: true, configurationTrusted: true, descriptionTrusted: true }) };
  return { paths, deps, close: () => rm(root, { recursive: true, force: true }) };
}

test("CLI accepts only documented operation-specific arguments", () => {
  for (const args of [["info", "--show-token"], ["setup", "--json"], ["setup", "--codex-name"], ["setup", "--codex-url=http://x/mcp"], ["info", "--json", "--json"], ["setup", "--path", "/tmp"], ["setup", "--codex-name", "bad-name"]])
    assert.throws(() => parseManagementArgs(args));
  assert.equal(parseManagementArgs(["setup", "--codex-name=cb_host", "--codex-url", "https://[::1]/mcp"]).url, "https://[::1]/mcp");
});

test("saved connection precedence, wildcard and IPv6 fallback require no network queries", () => {
  const saved = createClientSetup(null, "HOST.Test", { name: "cb_saved", url: "https://proxy.example/mcp", advertisedHost: "10.0.0.4" });
  const config = { COMMAND_BRIDGE_HTTP_HOST: "0.0.0.0" };
  assert.equal(resolveConnection(config, saved, "other").connectionUrl, "https://proxy.example/mcp");
  assert.equal(resolveConnection(config, saved, "other", { name: "cb_output", url: "https://other.example/mcp" }).connectionName, "cb_output");
  assert.equal(resolveConnection(config, null, "host").connectionUrl, "http://127.0.0.1:8800/mcp");
  assert.equal(resolveConnection({ COMMAND_BRIDGE_HTTP_HOST: "::" }, null, "host").connectionUrl, "http://[::1]:8800/mcp");
  for (const record of [{ ...saved, schemaVersion: 2 }, { ...saved, token }, { ...saved, explicitUrl: "https://user:secret@x/mcp" }, { ...saved, advertisedHost: "::" }])
    assert.throws(() => parseClientSetup(Buffer.from(JSON.stringify(record))));
  assert.throws(() => parseClientSetup(Buffer.from([0xff])));
  assert.match(renderCodexSetup(resolveConnection({}, null, "host")), /Token is hidden/);
});

test("installer creates token-free metadata and retains exact BOM/newlines on unchanged update", async () => {
  const f = await fixture();
  try {
    const candidate = join(f.paths.root, "candidate.json");
    await runClientSetupInstaller(["prepare", f.paths.config, f.paths.description, candidate, "cb_saved", "https://proxy.example/mcp", "-"]);
    const text = await readFile(candidate, "utf8"); assert.ok(!text.includes(token));
    await writeFile(f.paths.description, "\ufeff" + text.replaceAll("\n", "\r\n")); await rm(candidate);
    const before = await readFile(f.paths.description);
    await runClientSetupInstaller(["prepare", f.paths.config, f.paths.description, candidate, "-", "-", "-"]);
    assert.deepEqual(await readFile(candidate), before);
    await writeFile(f.paths.description, '{"schemaVersion":99}'); await rm(candidate);
    await assert.rejects(runClientSetupInstaller(["prepare", f.paths.config, f.paths.description, candidate, "-", "-", "-"]), { code: "CLIENT_SETUP_INVALID" });
    await rm(f.paths.description);
    await assert.rejects(runClientSetupInstaller(["prepare", f.paths.config, f.paths.description, candidate, "-", `https://private.example/${token}/mcp`, "-"]), { code: "CONNECTION_CONTAINS_SECRET" });
  } finally { await f.close(); }
});

test("info and hidden setup are read-only, secret-free and independent of invalid inherited config", async () => {
  const f = await fixture();
  try {
    const saved = createClientSetup(null, "host", { name: "cb_saved", url: "https://proxy.example/mcp" });
    await writeFile(f.paths.description, JSON.stringify(saved));
    const before = await Promise.all([f.paths.info, f.paths.config, f.paths.description, f.paths.current].map(path => readFile(path)));
    const info = await runInstalledManagement(["info", "--json"], f.paths, f.deps);
    assert.equal(info.exitCode, 0); assert.ok(!info.output.includes(token));
    const parsed = JSON.parse(info.output);
    assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.installed.sourceSha, sha); assert.equal(parsed.executionMode, "guarded");
    assert.equal(parsed.connection.listenerUrl, "http://[::1]:8800/mcp"); assert.equal(parsed.connection.connectionUrl, saved.explicitUrl);
    const setup = await runInstalledManagement(["setup", "--codex-name", "cb_output"], f.paths, f.deps);
    assert.ok(!setup.output.includes(token)); assert.match(setup.output, /mcp_servers.cb_output/); assert.match(setup.output, /tool_timeout_sec = 360.0/);
    await assert.rejects(runInstalledManagement(["setup", "--show-token"], f.paths, f.deps), { code: "ADMINISTRATOR_REQUIRED" });
    const admin = { ...f.deps, service: async (p: InstallationPaths) => ({ ...await f.deps.service(p), administrator: true }) };
    assert.ok((await runInstalledManagement(["setup", "--show-token"], f.paths, admin)).output.includes(token));
    assert.deepEqual(await Promise.all([f.paths.info, f.paths.config, f.paths.description, f.paths.current].map(path => readFile(path))), before);
  } finally { await f.close(); }
});

test("partial information reports permissions; invalid description cannot silently fall back", async () => {
  const f = await fixture();
  try {
    const limited = { ...f.deps, service: async (p: InstallationPaths) => ({ ...await f.deps.service(p), configurationTrusted: false }) };
    const partial = await runInstalledManagement(["info", "--json"], f.paths, limited);
    assert.equal(partial.exitCode, 1); assert.equal(JSON.parse(partial.output).tokenStatus, "unavailable");
    await assert.rejects(runInstalledManagement(["setup"], f.paths, limited), { code: "SETUP_UNAVAILABLE" });
    assert.match((await runInstalledManagement(["setup"], f.paths, f.deps)).output, /cannot be recovered automatically/);
    await writeFile(f.paths.description, "{}");
    await assert.rejects(runInstalledManagement(["setup"], f.paths, f.deps), { code: "SETUP_UNAVAILABLE" });
    assert.equal(JSON.parse((await runInstalledManagement(["info", "--json"], f.paths, f.deps)).output).connection, null);
  } finally { await f.close(); }
});

test("queries reject a concurrent deployment change and redact secrets before JSON escaping", async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.config, `COMMAND_BRIDGE_BEARER_TOKEN=${token}\nCOMMAND_BRIDGE_HTTP_HOST=127.0.0.1\nCOMMAND_BRIDGE_ALLOWED_ROOTS=C:\\${token}\n`);
    const info = await runInstalledManagement(["info", "--json"], f.paths, f.deps);
    assert.ok(!info.output.includes(token)); assert.ok(JSON.parse(info.output).locations.workRoots[0].includes("[REDACTED]"));
    const changed = { ...f.deps, service: async (p: InstallationPaths) => { await writeFile(p.current, JSON.stringify({ version, sourceSha: "b".repeat(40) })); return f.deps.service(p); } };
    await assert.rejects(runInstalledManagement(["info"], f.paths, changed), { code: "INSTALLATION_CHANGED" });
  } finally { await f.close(); }
});

test("installation metadata must use string SHA and Runtime fields", async () => {
  const f = await fixture();
  try {
    for (const data of [{ version, sourceSha: [sha], runtimeVersion: "24.18.0" }, { version, sourceSha: sha, runtimeVersion: ["24.18.0"] }]) {
      await writeFile(f.paths.info, JSON.stringify(data));
      await assert.rejects(runInstalledManagement(["info", "--json"], f.paths, f.deps), { code: "INSTALLED_METADATA_INVALID" });
    }
  } finally { await f.close(); }
});

test("information output remains within 64 KiB even with many configured roots", async () => {
  const f = await fixture();
  try {
    const roots = Array.from({ length: 100 }, (_, i) => `C:\\${i}_${"x".repeat(800)}`).join(";");
    await writeFile(f.paths.config, `COMMAND_BRIDGE_BEARER_TOKEN=${token}\nCOMMAND_BRIDGE_ALLOWED_ROOTS=${roots}\n`);
    await assert.rejects(runInstalledManagement(["info", "--json"], f.paths, f.deps), { code: "OUTPUT_LIMIT" });
  } finally { await f.close(); }
});

test("installer query verification checks real service state and refuses secret-bearing output", async () => {
  const f = await fixture();
  try {
    const infoFile = join(f.paths.root, "info.json"), setupFile = join(f.paths.root, "setup.txt");
    await writeFile(infoFile, (await runInstalledManagement(["info", "--json"], f.paths, f.deps)).output);
    await writeFile(setupFile, (await runInstalledManagement(["setup"], f.paths, f.deps)).output);
    await verifyQueries([f.paths.config, infoFile, setupFile, sha]);
    await writeFile(setupFile, "Token is hidden. " + token);
    await assert.rejects(verifyQueries([f.paths.config, infoFile, setupFile, sha]), { code: "QUERY_VERIFICATION_FAILED" });
  } finally { await f.close(); }
});

test("record reads are bounded and fixed service queries terminate within their deadline", async () => {
  const f = await fixture();
  try {
    await assert.rejects(readRecord(f.paths.config, 1), { code: "RECORD_INVALID" });
    await assert.rejects(readRecord(f.paths.root, 16384), { code: "RECORD_INVALID" });
    assert.equal(await runServiceQuery(process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, 80), null);
    assert.equal(await runServiceQuery(process.execPath, ["-e", "process.stdout.write('x'.repeat(20000))"], {}), null);
    assert.equal(parseLinuxService("LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nUser=installer").state, "running");
  } finally { await f.close(); }
});

test("Linux management verifies the active release and rejects unprotected ancestry", { skip: process.platform !== "linux" }, async () => {
  const f = await fixture("linux");
  try {
    assert.equal((await runInstalledManagement(["info", "--json"], f.paths, f.deps)).exitCode, 0);
    await chmod(f.paths.root, 0o777);
    await assert.rejects(assertAdminPath(f.paths.info), { code: "INSTALLATION_UNSAFE" });
    await rm(f.paths.current); await symlink(f.paths.root, f.paths.current);
    await assert.rejects(runInstalledManagement(["setup"], f.paths, f.deps), { code: "INSTALLATION_CHANGED" });
  } finally { await f.close(); }
});

test("Windows fixed native service query returns only the bounded schema without raw errors", { skip: process.platform !== "win32" }, async () => {
  const result = await queryService("win32", process.cwd());
  assert.equal(typeof result.administrator, "boolean");
  assert.equal(result.programTrusted, false, "The user-owned source checkout is not a protected installation");
  assert.deepEqual(Object.keys(result).sort(), ["account", "administrator", "autoStart", "configurationTrusted", "descriptionTrusted", "programTrusted", "state"]);
});
