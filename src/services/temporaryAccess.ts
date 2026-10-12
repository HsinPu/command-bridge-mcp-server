import { randomUUID } from "node:crypto";
import type { ExecutionMode } from "./commandPolicy.js";

export interface AccessLease { schemaVersion: 1; instanceId: string; id: string; action: "open" | "close"; issuedAt: number; expiresAt: number }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseAccessLease(text: string): AccessLease {
  const v = JSON.parse(text);
  if (!v || Object.keys(v).sort().join(",") !== "action,expiresAt,id,instanceId,issuedAt,schemaVersion" || v.schemaVersion !== 1 ||
      !uuid.test(v.instanceId) || !uuid.test(v.id) || !["open", "close"].includes(v.action) ||
      !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) || v.issuedAt <= 0 ||
      (v.action === "open" ? v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > 3600000 : v.expiresAt !== v.issuedAt)) throw Error("Invalid temporary access record");
  return v;
}

/** A root/admin-written lease is bound to this boot; no configuration is edited. */
export class TemporaryAccess {
  readonly instanceId: string;
  private active?: { lease: AccessLease; deadline: number };
  private revoked = new Set<string>();
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private generation = 0;
  private lifecycle = new Set<Promise<void>>();
  private lastWall: number;
  constructor(readonly baseMode: ExecutionMode, private readonly readLease: () => Promise<string | null>,
    private readonly audit: (action: "opened" | "closed" | "expired" | "invalidated") => Promise<void>,
    private readonly wall = Date.now, private readonly monotonic = () => performance.now(), instanceId = randomUUID()) {
    this.instanceId = instanceId; this.lastWall = wall();
  }
  mode(): ExecutionMode {
    const now = this.wall();
    if (now < this.lastWall || (this.active && (now >= this.active.lease.expiresAt || this.monotonic() >= this.active.deadline))) {
      this.invalidate(now < this.lastWall ? "invalidated" : "expired");
    }
    this.lastWall = now;
    return this.active && !this.stopped ? "unrestricted" : this.baseMode;
  }
  status() {
    const effectiveMode = this.mode();
    return { schemaVersion: 1, instanceId: this.instanceId, baseMode: this.baseMode, effectiveMode,
      grantId: this.active?.lease.id ?? null, expiresAt: this.active?.lease.expiresAt ?? null,
      remainingSeconds: this.active ? Math.max(0, Math.ceil(Math.min(this.active.lease.expiresAt - this.wall(), this.active.deadline - this.monotonic()) / 1000)) : 0 };
  }
  async refresh(): Promise<ExecutionMode> {
    if (this.stopped) return this.baseMode;
    if (!this.pending) {
      const operation = this.readAndApply(this.generation); this.pending = operation;
      void operation.finally(() => { if (this.pending === operation) this.pending = undefined; }).catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Access read deadline")), 5000); })]); }
    catch { this.generation++; this.invalidate("invalidated"); }
    finally { if (timer) clearTimeout(timer); }
    return this.mode();
  }
  private async readAndApply(generation: number) {
    try {
      const text = await this.readLease();
      if (generation !== this.generation || this.stopped) {
        if (text) { try { this.revoked.add(parseAccessLease(text).id); } catch {} }
        return;
      }
      if (text === null) { this.invalidate("invalidated"); return; }
      const lease = parseAccessLease(text), now = this.wall();
      this.mode();
      if (this.stopped || lease.instanceId !== this.instanceId || lease.issuedAt > now || lease.expiresAt <= now || lease.action === "close") {
        this.invalidate(lease.action === "close" ? "closed" : "invalidated"); return;
      }
      if (this.active?.lease.id === lease.id) {
        if (JSON.stringify(this.active.lease) !== JSON.stringify(lease)) this.invalidate("invalidated");
        return;
      }
      if (this.revoked.has(lease.id)) return;
      this.invalidate("closed");
      // Mark before awaiting Audit: timed-out work must never grant access later.
      this.revoked.add(lease.id);
      if (this.revoked.size > 1024) return;
      const deadline = this.monotonic() + lease.expiresAt - now;
      await this.audit("opened");
      if (this.stopped || generation !== this.generation || this.wall() >= lease.expiresAt || this.wall() < now || this.monotonic() >= deadline) return;
      // A concurrent administrator close/renew during Audit must win before
      // the grant becomes visible to commands or status callers.
      const confirmed = await this.readLease();
      if (confirmed !== text || this.stopped || generation !== this.generation || this.wall() >= lease.expiresAt || this.monotonic() >= deadline) {
        await this.audit("invalidated"); return;
      }
      this.active = { lease, deadline };
      this.timer = setTimeout(() => this.mode(), Math.max(1, deadline - this.monotonic())); this.timer.unref();
    } catch { this.invalidate("invalidated"); }
  }
  private invalidate(action: "closed" | "expired" | "invalidated") {
    if (!this.active) return;
    this.revoked.add(this.active.lease.id); this.active = undefined;
    if (this.timer) clearTimeout(this.timer);
    const event = this.audit(action); this.lifecycle.add(event);
    void event.finally(() => this.lifecycle.delete(event)).catch(() => undefined);
  }
  async stop() { this.stopped = true; this.generation++; this.invalidate("closed"); if (this.timer) clearTimeout(this.timer); await Promise.allSettled([...this.lifecycle, ...(this.pending ? [this.pending] : [])]); }
}
