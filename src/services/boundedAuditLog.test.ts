import test from "node:test";
import assert from "node:assert/strict";
import { BoundedAuditLog } from "./boundedAuditLog.js";
import { createAuditEvent } from "./auditLog.js";

const event = () => createAuditEvent({ command: "diagnostic", phase: "attempted", executionMode: "allowlist", source: "stdio" });
test("Audit deadlines stop queued operations while tracking actual unfinished I/O", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0, reads = 0;
  const audit = new BoundedAuditLog({ async write() { writes++; await gate; }, async list() { reads++; return { events: [], hasMore: false }; } }, 30);
  try {
    const first = assert.rejects(audit.write(event()), (e: any) => e.code === "AUDIT_LOG_WRITE_FAILED");
    const queued = assert.rejects(audit.list(1), (e: any) => e.code === "AUDIT_LOG_READ_FAILED");
    await Promise.all([first, queued]);
    assert.equal(audit.available, false);
    let drained = false;
    const draining = audit.drain().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(drained, false);
    await assert.rejects(audit.write(event()), (e: any) => e.code === "AUDIT_LOG_WRITE_FAILED");
    release(); await draining;
    assert.equal(writes, 1);
    assert.equal(reads, 0);
    assert.equal(audit.available, false); // Late completion must not silently resume service.
  } finally { release(); await audit.drain(); }
});

test("Audit admission remains bounded before any timeout expires", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const audit = new BoundedAuditLog({ async write() { await gate; }, async list() { return { events: [], hasMore: false }; } });
  const operations = Array.from({ length: 65 }, () => audit.write(event()));
  const settled = Promise.allSettled(operations);
  release(); await settled; await audit.drain();
  assert.equal(audit.available, false);
  assert.equal((await settled).filter(x => x.status === "rejected").length, 65);
});
