import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

test("Linux program relocation preserves originals, rolls back, and removes all managed roots", {skip:process.platform!=="linux"},()=>{
  const result=spawnSync("bash",["scripts/linux-systemd/tests/layout.test.sh"],{encoding:"utf8",timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr+String(result.error??""));
});
