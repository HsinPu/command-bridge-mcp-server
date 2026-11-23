import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { applyLinuxAccessLabel, publishLinuxAccessLease } from "./accessStorage.js";

const expected = "system_u:object_r:command_bridge_config_t:s0";
const original = "unconfined_u:object_r:command_bridge_config_t:s0";

test("temporary access applies the full final-path context even if only the SELinux user differs", async () => {
  const stage = "/etc/command-bridge/.access-lease.fixture";
  const destination = "/etc/command-bridge/access-lease.json";
  let actual = original;
  await applyLinuxAccessLabel(stage, destination, async (tool, args) => {
    if (tool === "/usr/sbin/matchpathcon") {
      assert.deepEqual(args, ["-n", "-m", "file", destination]);
      return expected + "\n";
    }
    if (tool === "/usr/bin/chcon") {
      assert.deepEqual(args, ["--", expected, stage]);
      actual = expected;
      return "";
    }
    assert.equal(tool, "/usr/bin/stat");
    assert.deepEqual(args, ["--format=%C", "--", stage]);
    return actual;
  });
  assert.equal(actual, expected);
});

test("temporary access rejects an unresolved policy or a label that did not change", async () => {
  for (const lookup of [null, "<<none>>", expected]) {
    await assert.rejects(applyLinuxAccessLabel("/stage", "/lease", async tool => {
      if (tool === "/usr/sbin/matchpathcon") return lookup;
      assert.equal(lookup, expected, "an invalid policy must stop before using other tools");
      return tool === "/usr/bin/stat" ? original : "";
    }), { code: "ACCESS_LABEL_FAILED" });
  }
});

test("Linux never publishes an unverified lease and preserves the previous record on failure", {
  skip: process.platform !== "linux" || process.geteuid?.() !== 0
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "command-bridge-access-"));
  const path = join(directory, "access-lease.json");
  const group = process.getegid!();
  const label = async (stage: string, destination: string) => {
    assert.notEqual(stage, path);
    assert.equal(destination, path);
    const info = await lstat(stage);
    assert.equal(info.uid, 0);
    assert.equal(info.gid, group);
    assert.equal(info.mode & 0o777, 0o640);
  };
  const fail = (result: string | null) => (stage: string, destination: string) =>
    applyLinuxAccessLabel(stage, destination, async tool => {
      if (tool === "/usr/sbin/matchpathcon") return expected;
      if (tool === "/usr/bin/stat") return original;
      return result;
    });
  try {
    await assert.rejects(publishLinuxAccessLease(path, "failed first grant", group, fail(null)), { code: "ACCESS_LABEL_FAILED" });
    assert.deepEqual(await readdir(directory), []);
    await publishLinuxAccessLease(path, "prior record", group, label);
    await assert.rejects(publishLinuxAccessLease(path, "failed renewal", group, fail("")), { code: "ACCESS_LABEL_FAILED" });
    assert.equal(await readFile(path, "utf8"), "prior record");
    assert.deepEqual(await readdir(directory), [basename(path)]);
    await publishLinuxAccessLease(path, "new record", group, async (stage, destination) => {
      await label(stage, destination);
      assert.equal(await readFile(path, "utf8"), "prior record");
    });
    assert.equal(await readFile(path, "utf8"), "new record");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
