import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { terminateProcessTree } from "./commandExecutor.js";

test("Windows taskkill failure waits for natural process and pipe closure before accepting the exit race", { skip: process.platform !== "win32" }, async t => {
  const killer = Object.assign(new EventEmitter(), { kill() {} });
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null as number | null, signalCode: null, stdout: { readableEnded: false }, stderr: { readableEnded: false } });
  const mock = t.mock.method(childProcess, "spawn", () => killer as unknown as ChildProcess);
  syncBuiltinESMExports();
  try {
    let state = "pending";
    const operation = terminateProcessTree(child as unknown as ChildProcess).then(() => { state = "complete"; }, () => { state = "failed"; });
    killer.emit("close", 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(state, "pending", "A taskkill/exit race must wait for independent completion evidence.");
    child.exitCode = 0;
    child.stdout.readableEnded = true;
    child.emit("exit", 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(state, "pending", "One remaining captured pipe must prevent a success claim.");
    child.stderr.readableEnded = true;
    child.emit("close", 0);
    await operation;
    assert.equal(state, "complete");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows exited leaders with live pipes are not considered already terminated", { skip: process.platform !== "win32" }, async t => {
  const killer = Object.assign(new EventEmitter(), { kill() {} });
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: 0, signalCode: null, stdout: { readableEnded: false }, stderr: { readableEnded: true } });
  const mock = t.mock.method(childProcess, "spawn", () => killer as unknown as ChildProcess);
  syncBuiltinESMExports();
  try {
    let state = "pending";
    const operation = terminateProcessTree(child as unknown as ChildProcess).then(() => { state = "complete"; }, () => { state = "failed"; });
    killer.emit("close", 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(state, "pending");
    child.stdout.readableEnded = true; child.emit("close", 0);
    await operation; assert.equal(state, "complete");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows taskkill completion without process closure fails within the existing deadline", { skip: process.platform !== "win32" }, async t => {
  const killer = Object.assign(new EventEmitter(), { kill() {} });
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null, stdout: { readableEnded: false }, stderr: { readableEnded: false } });
  const mock = t.mock.method(childProcess, "spawn", () => killer as unknown as ChildProcess);
  syncBuiltinESMExports();
  try {
    const started = Date.now(), operation = terminateProcessTree(child as unknown as ChildProcess);
    killer.emit("close", 1);
    await assert.rejects(operation, /deadline/);
    assert.ok(Date.now() - started < 7000);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
