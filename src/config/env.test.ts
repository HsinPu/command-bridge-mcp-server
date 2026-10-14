import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./env.js";
import { jobStorageSettings } from "../cli/connectionSetup.js";

test("background configuration stays opt-in for old configs and parses saved quoted values", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    assert.equal(loadConfig().jobs!.enabled, false);
    assert.deepEqual(jobStorageSettings(Buffer.from('COMMAND_BRIDGE_JOBS_ENABLED="true"\nCOMMAND_BRIDGE_JOBS_ROOT="/private jobs"\n')), { enabled: true, root: "/private jobs" });
    process.env.COMMAND_BRIDGE_JOBS_ENABLED = "true";
    assert.throws(loadConfig, /absolute/);
    process.env.COMMAND_BRIDGE_JOBS_ROOT = process.cwd();
    assert.equal(loadConfig().jobs!.enabled, true);
    process.env.COMMAND_BRIDGE_JOBS_MAX_TIMEOUT_MS = "1000";
    assert.throws(loadConfig, /below/);
    assert.throws(() => jobStorageSettings(Buffer.from("COMMAND_BRIDGE_JOBS_ENABLED=unexpected\n")), /Invalid/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("long command limits retain the ordinary default and explicit host overrides", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    const defaults = loadConfig();
    assert.equal(defaults.defaultTimeoutMs, 15_000);
    assert.equal(defaults.maxTimeoutMs, 300_000);
    process.env.COMMAND_BRIDGE_MAX_TIMEOUT_MS = "60000";
    assert.equal(loadConfig().maxTimeoutMs, 60_000);
    process.env.COMMAND_BRIDGE_DEFAULT_TIMEOUT_MS = "90000";
    assert.throws(loadConfig, /greater than or equal/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("environment Host validation normalizes existing hostname:port configuration and rejects malformed values", () => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COMMAND_BRIDGE_")));
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    process.env.COMMAND_BRIDGE_ALLOWED_HOSTS = "Bridge.INTERNAL:8800,[::1]:8800";
    assert.deepEqual(loadConfig().allowedHosts, ["bridge.internal", "[::1]"]);
    process.env.COMMAND_BRIDGE_ALLOWED_HOSTS = "https://bridge.internal/mcp";
    assert.throws(loadConfig, /COMMAND_BRIDGE_ALLOWED_HOSTS/);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("COMMAND_BRIDGE_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
