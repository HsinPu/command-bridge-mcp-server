import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertCommandAllowed,
  resolveWorkingDirectory,
  type CommandPolicyConfig
} from "./commandPolicy.js";
import { parseLiteralCommand, resolveSafeCommand } from "./commandPolicy.js";
import { loadCommandProfiles, validateEnabledProfiles } from "./commandProfiles.js";
const shell = process.platform === "win32" ? "powershell" : "bash";

const policy: CommandPolicyConfig = {
  executionMode: "allowlist",
  allowedShells: [shell],
  allowedCommands: new Set(["hostname"]),
  allowedRoots: [resolve("sandbox")]
};

test("allowlist accepts a simple configured command", () => {
  assert.doesNotThrow(() => assertCommandAllowed(policy, shell, "hostname"));
});

test("allowlist blocks command chaining", () => {
  assert.throws(
    () => assertCommandAllowed(policy, shell, "hostname; whoami"),
    /Shell control syntax/
  );
});
test("allowlist rejects an unconfigured command", () => {
  assert.throws(() => assertCommandAllowed(policy, shell, "whoami"), /not in the configured/);
});

test("working directory stays under an allowed root", () => {
  const root = mkdtempSync(join(tmpdir(), "command-bridge-roots-"));
  const child = join(root, "..valid");
  mkdirSync(child);
  try {
  assert.equal(resolveWorkingDirectory([root], child), realpathSync(child));
  assert.throws(
    () => resolveWorkingDirectory([root], resolve("outside")),
    /outside the configured roots/
  );
  const link = join(root, "escape");
  symlinkSync(tmpdir(), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveWorkingDirectory([root], link), /outside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("literal parser preserves quoted arguments and rejects shell expressions", () => {
  assert.deepEqual(parseLiteralCommand('hostname "two words" \'\''), ["hostname", "two words", ""]);
  for (const input of ['hostname(foo)', 'hostname$(id)', 'hostname/other', 'hostname | whoami', 'hostname %PATH%', 'hostname "unclosed', 'hostname\nwhoami', 'hostname *', 'hostname `id`']) assert.throws(() => parseLiteralCommand(input));
  assert.throws(() => resolveSafeCommand(policy, shell, "hostname --unexpected"), /Arguments/);
});

test("custom native policies require exact argv, unique names and valid native paths", () => {
  const root = mkdtempSync(join(tmpdir(), "command-bridge-policy-"));
  const file = join(root, "policy.json");
  const executable = loadCommandProfiles().get("hostname")!.executable;
  const entry = { name: "inspect-host", platform: process.platform, shells: [shell], executable, allowedArgs: [[], ["literal value"]] };
  const write = (commands: unknown[]) => writeFileSync(file, JSON.stringify({ schemaVersion: 1, commands }));
  try {
    write([entry]);
    const commandProfiles = loadCommandProfiles(file);
    const cfg = { ...policy, allowedCommands: new Set(["inspect-host"]), commandProfiles };
    assert.deepEqual(resolveSafeCommand(cfg, shell, 'inspect-host "literal value"').args, ["literal value"]);
    assert.throws(() => resolveSafeCommand(cfg, shell, "inspect-host other"));
    assert.throws(() => validateEnabledProfiles(commandProfiles, new Set(["missing"]), [shell]), /No safe policy/);
    write([entry, entry]); assert.throws(() => loadCommandProfiles(file), /Duplicate/);
    write([{ ...entry, executable: process.execPath }]); assert.throws(() => loadCommandProfiles(file), /script hosts/);
    write([{ ...entry, executable: "relative" }]); assert.throws(() => loadCommandProfiles(file), /absolute/);
    writeFileSync(file, '{"schemaVersion":2,"commands":[]}'); assert.throws(() => loadCommandProfiles(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
