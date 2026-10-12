import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, networkInterfaces } from "node:os";
import { get } from "node:http";
import { isIP } from "node:net";
import { isModuleEntry } from "./moduleEntry.js";
import { installedPaths, runInstalledManagement, type InstallationPaths } from "./management.js";
import { queryService } from "./serviceStatus.js";
import { CliError, parseSavedConfiguration, resolveConnection } from "./connectionSetup.js";
import { readRecord, readFailure, fileIdentity } from "./managedFiles.js";
import { writeAccessLease } from "./accessStorage.js";
import { normalizeAllowedHosts } from "../config/allowedHosts.js";

export function parseAccessArgs(args: string[]) {
  if (args[0] !== "access" || !["open", "status", "close"].includes(args[1] ?? "")) throw new CliError("ACCESS_ARGUMENTS_INVALID", 2);
  let minutes = 5;
  if (args[1] === "open" && args.length === 4 && args[2] === "--minutes" && /^(?:[1-9]|[1-5][0-9]|60)$/.test(args[3]!)) minutes = Number(args[3]);
  else if (args.length !== 2) throw new CliError("ACCESS_ARGUMENTS_INVALID", 2);
  return { action: args[1] as "open" | "status" | "close", minutes };
}
export interface AccessStatus { schemaVersion: 1; instanceId: string; baseMode: string; effectiveMode: string; grantId: string | null; expiresAt: number | null; remainingSeconds: number }
export function validateAccessStatus(v: AccessStatus): AccessStatus {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!v || v.schemaVersion !== 1 || !uuid.test(v.instanceId) || !["allowlist", "guarded", "unrestricted"].includes(v.baseMode) ||
      ![v.baseMode, "unrestricted"].includes(v.effectiveMode) || (v.grantId !== null && !uuid.test(v.grantId)) ||
      (v.expiresAt !== null && !Number.isSafeInteger(v.expiresAt)) || !Number.isInteger(v.remainingSeconds) || v.remainingSeconds < 0 || v.remainingSeconds > 3600 ||
      (v.grantId === null ? v.expiresAt !== null || v.remainingSeconds !== 0 : v.expiresAt === null || v.effectiveMode !== "unrestricted")) throw new CliError("ACCESS_STATUS_INVALID");
  return v;
}
export async function readAccessStatus(values: Record<string, string>): Promise<AccessStatus> {
  const connection = resolveConnection(values, null, hostname());
  const url = new URL(connection.listenerUrl.replace(/\/mcp$/, "/access"));
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = Object.values(networkInterfaces()).flat().some(v => v?.address === host);
  if (!local && host !== "localhost" && host !== "::1" && !(isIP(host) === 4 && host.startsWith("127."))) throw new CliError("ACCESS_LOCAL_LISTENER_REQUIRED");
  const token = values.COMMAND_BRIDGE_BEARER_TOKEN;
  if (!token || !/^[A-Za-z0-9._~-]{32,}$/.test(token)) throw new CliError("TOKEN_INVALID");
  const allowed = normalizeAllowedHosts(values.COMMAND_BRIDGE_ALLOWED_HOSTS);
  const header = allowed[0] ?? (host === "localhost" ? "localhost" : undefined);
  const call = (target: URL) => new Promise<AccessStatus>((resolve, reject) => {
    const challenge = randomBytes(32).toString("hex");
    const proof = createHmac("sha256", token).update("access-request:" + challenge).digest("hex");
    const request = get(target, { agent: false, headers: { Authorization: "CommandBridge-HMAC " + proof, "X-CommandBridge-Challenge": challenge, ...(header ? { Host: header } : {}) } }, response => {
      let text = "", bytes = 0;
      response.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 4096) request.destroy(Error("limit")); else text += data.toString("utf8"); });
      response.once("error", () => reject(new CliError("ACCESS_SERVICE_UNAVAILABLE")));
      response.once("end", () => {
        try {
          if (response.statusCode !== 200) throw Error();
          const { signature, ...status } = JSON.parse(text);
          const expected = createHmac("sha256", token).update("access-response:" + challenge + ":" + JSON.stringify(status)).digest("hex");
          if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) throw Error();
          resolve(validateAccessStatus(status));
        } catch { reject(new CliError("ACCESS_SERVICE_UNAVAILABLE")); }
      });
    });
    const timer = setTimeout(() => request.destroy(Error("deadline")), 4000);
    request.once("close", () => clearTimeout(timer)); request.once("error", () => reject(new CliError("ACCESS_SERVICE_UNAVAILABLE")));
  });
  if (host === "localhost") {
    // Pin loopback addresses rather than trusting hosts-file/DNS resolution.
    url.hostname = "[::1]";
    try { return await call(url); } catch { url.hostname = "127.0.0.1"; return call(url); }
  }
  return call(url);
}
export async function runAccess(args: string[], paths: InstallationPaths) {
  const options = parseAccessArgs(args);
  const service = await queryService(paths.platform, paths.release);
  if (!service.administrator) throw new CliError("ADMINISTRATOR_REQUIRED");
  if (service.state !== "running") throw new CliError("ACCESS_SERVICE_NOT_RUNNING");
  const checked = await runInstalledManagement(["info", "--json"], paths);
  if (checked.exitCode !== 0) throw new CliError("ACCESS_INSTALLATION_UNAVAILABLE");
  const identity = await fileIdentity(paths.current);
  const values = parseSavedConfiguration(await readRecord(paths.config, 1048576));
  const before = await readAccessStatus(values);
  if (options.action === "status") return before;
  if (options.action === "open" && before.baseMode === "unrestricted") throw new CliError("ACCESS_ALREADY_UNRESTRICTED");
  const now = Date.now(), id = randomUUID();
  const payload = JSON.stringify({ schemaVersion: 1, instanceId: before.instanceId, id, action: options.action, issuedAt: now, expiresAt: now + (options.action === "open" ? options.minutes * 60000 : 0) });
  await writeAccessLease(payload);
  let after: AccessStatus;
  try { after = await readAccessStatus(values); }
  catch (error) {
    if (options.action === "open") {
      const closed = Date.now();
      await writeAccessLease(JSON.stringify({ schemaVersion: 1, instanceId: before.instanceId, id: randomUUID(), action: "close", issuedAt: closed, expiresAt: closed }));
    }
    throw error;
  }
  if (after.instanceId !== before.instanceId || await fileIdentity(paths.current) !== identity) throw new CliError("ACCESS_SERVICE_CHANGED");
  if (options.action === "open" && after.grantId !== id) {
    // A failed grant must not remain eligible for delayed activation.
    const closed = Date.now();
    await writeAccessLease(JSON.stringify({ schemaVersion: 1, instanceId: before.instanceId, id: randomUUID(), action: "close", issuedAt: closed, expiresAt: closed }));
    throw new CliError("ACCESS_NOT_ACTIVATED");
  }
  if (options.action === "close" && after.grantId !== null) throw new CliError("ACCESS_CHANGED");
  return after;
}
if (isModuleEntry(import.meta.url)) {
  const timer = setTimeout(() => { process.stderr.write("CommandBridge access: ACCESS_DEADLINE; inspect access status before retrying.\n", () => process.exit(1)); }, 15000);
  const paths = () => installedPaths(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  Promise.resolve().then(() => runAccess(process.argv.slice(2), paths())).then(status => {
    clearTimeout(timer); process.stdout.write(`Base mode: ${status.baseMode}\nEffective mode: ${status.effectiveMode}\nRemaining: ${status.remainingSeconds} seconds\nExpires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : "none"}\n`);
  }).catch(error => { clearTimeout(timer); process.stderr.write(`CommandBridge access: ${readFailure(error)}\n`); process.exitCode = error instanceof CliError ? error.exitCode : 1; });
}
