import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("install channel publishes successful snapshots without tags and cannot go backward", { skip: spawnSync("git", ["--version"], { windowsHide: true, stdio: "ignore" }).status !== 0 ? "Git is needed only for CI channel publication, not installation" : false }, () => {
  const directory = mkdtempSync(join(tmpdir(), "command-bridge-channel-"));
  const remote = join(directory, "remote.git");
  const repo = join(directory, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--bare", remote); git("init", "-b", "main", repo);
    git("-C", repo, "remote", "add", "origin", remote);
    const commit = (version: string) => {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
      git("-C", repo, "add", "package.json");
      git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", version);
      git("-C", repo, "push", "origin", "main");
      return git("-C", repo, "rev-parse", "HEAD");
    };
    const publish = (sha: string, event = "push") => spawnSync(process.execPath, [resolve("scripts/publish-channel.mjs")], { cwd: repo, encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha } });
    const first = commit("0.5.0");
    assert.notEqual(publish(first, "pull_request").status, 0);
    assert.equal(git("-C", repo, "ls-remote", "--heads", "origin", "install-channel"), "");
    const result = publish(first); assert.equal(result.status, 0, result.stderr);
    const second = commit("1.0.0");
    assert.equal(publish(second).status, 0);
    assert.equal(publish(first).status, 0);
    git("-C", repo, "fetch", "origin", "install-channel");
    assert.equal(git("-C", repo, "show", "FETCH_HEAD:channel.txt"), `${second}\n1.0.0`);
    assert.equal(git("-C", repo, "tag"), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
