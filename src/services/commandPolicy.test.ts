import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertCommandAllowed,
  resolveWorkingDirectory,
  type CommandPolicyConfig
} from "./commandPolicy.js";

const policy: CommandPolicyConfig = {
  executionMode: "allowlist",
  allowedShells: ["bash"],
  allowedCommands: new Set(["hostname"]),
  allowedRoots: [resolve("sandbox")]
};

test("allowlist accepts a simple configured command", () => {
  assert.doesNotThrow(() => assertCommandAllowed(policy, "bash", "hostname"));
});

test("allowlist blocks command chaining", () => {
  assert.throws(
    () => assertCommandAllowed(policy, "bash", "hostname; whoami"),
    /Shell control syntax/
  );
});
test("allowlist rejects an unconfigured command", () => {
  assert.throws(() => assertCommandAllowed(policy, "bash", "whoami"), /not in the configured/);
});

test("working directory stays under an allowed root", () => {
  const child = join(policy.allowedRoots[0]!, "child");
  assert.equal(resolveWorkingDirectory(policy.allowedRoots, child), resolve(child));
  assert.throws(
    () => resolveWorkingDirectory(policy.allowedRoots, resolve("outside")),
    /outside the configured roots/
  );
});
