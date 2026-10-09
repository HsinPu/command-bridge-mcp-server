import { hostname } from "node:os";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeUtf8File } from "../services/textEncoding.js";
import { version } from "../version.js";
import { CliError, connectionName, httpsConnectionUrl, parseClientSetup, parseSavedConfiguration, renderCodexSetup, resolveConnection } from "./connectionSetup.js";
import { assertAdminPath, fileIdentity, readFailure, readRecord } from "./managedFiles.js";
import { queryService, type ServiceStatus } from "./serviceStatus.js";

const help = "Usage: command-bridge info [--json] | setup [--show-token] [--codex-name NAME] [--codex-url HTTPS_URL]\nThese are local terminal queries. MCP command execution blocks direct calls.\n";
export interface ManagementArgs { operation: "info" | "setup"; json: boolean; showToken: boolean; name?: string; url?: string; help: boolean }
export function parseManagementArgs(args: string[]): ManagementArgs {
  if (!["info", "setup"].includes(args[0] ?? "")) throw new CliError("ARGUMENTS_INVALID", 2);
  const result: ManagementArgs = { operation: args[0] as "info" | "setup", json: false, showToken: false, help: false };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const [key, inline] = arg.split(/=(.*)/s);
    if (seen.has(key!)) throw new CliError("ARGUMENTS_INVALID", 2);
    seen.add(key!);
    if ((key === "--help" || key === "-h") && inline === undefined) result.help = true;
    else if (result.operation === "info" && key === "--json" && inline === undefined) result.json = true;
    else if (result.operation === "setup" && key === "--show-token" && inline === undefined) result.showToken = true;
    else if (result.operation === "setup" && ["--codex-name", "--codex-url"].includes(key!)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("--")) throw new CliError("ARGUMENTS_INVALID", 2);
      if (key === "--codex-name") result.name = connectionName(value); else result.url = httpsConnectionUrl(value);
    } else throw new CliError("ARGUMENTS_INVALID", 2);
  }
  return result;
}

export interface InstallationPaths {
  platform: NodeJS.Platform; root: string; release: string; runtime: string; config: string; description: string; info: string; current: string;
}
export function installedPaths(release: string, platform = process.platform): InstallationPaths {
  const roots = platform === "linux" ? ["/usr/local/lib/command-bridge", "/opt/command-bridge", "/opt/command-bridge-mcp-server"] :
    platform === "win32" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "CommandBridgeMCP")] : [];
  const root = roots.find(candidate => /^releases[/\\]v\d+\.\d+\.\d+-[a-f0-9]{40}$/.test(relative(candidate, release)));
  if (!root) throw new CliError("SERVICE_INSTALLATION_REQUIRED", 3);
  const configRoot = platform === "linux" ? "/etc/command-bridge" : join(process.env.ProgramData ?? "C:\\ProgramData", "CommandBridgeMCP");
  return { platform, root, release, runtime: platform === "linux" ? join(root, "runtime/current") : join(root, "runtime"),
    config: join(configRoot, "command-bridge.env"), description: join(configRoot, "client-setup.json"), info: join(release, "install-info.json"),
    current: platform === "linux" ? join(root, "current") : join(root, "install-info.json") };
}

export interface ManagementDependencies {
  hostname(): string;
  service(paths: InstallationPaths): Promise<ServiceStatus>;
  trust(path: string): Promise<void>;
  expectedVersion: string;
}
const dependencies: ManagementDependencies = {
  hostname, expectedVersion: version,
  service: paths => queryService(paths.platform, paths.release),
  trust: async path => { if (process.platform === "linux") await assertAdminPath(path); }
};

export async function runInstalledManagement(args: string[], paths: InstallationPaths, deps: ManagementDependencies = dependencies) {
  const flags = parseManagementArgs(args);
  if (flags.help) return { output: help, exitCode: 0 };
  await deps.trust(paths.release);
  const tracked = [paths.current, paths.runtime, paths.info, paths.config, paths.description];
  const initial = await Promise.all(tracked.map(fileIdentity));
  const service = await deps.service(paths);
  if (paths.platform === "win32" && !service.programTrusted) throw new CliError("INSTALLATION_UNSAFE");
  if (paths.platform === "linux" && await realpath(paths.current) !== await realpath(paths.release)) throw new CliError("INSTALLATION_CHANGED");
  let installed: { version: string; sourceSha: string; runtimeVersion: string };
  try {
    const data = JSON.parse(decodeUtf8File(await readRecord(paths.info, 16384)));
    if (!data || typeof data.version !== "string" || typeof data.sourceSha !== "string" || typeof data.runtimeVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(data.version) || !/^[a-f0-9]{40}$/.test(data.sourceSha) || !/^\d+\.\d+\.\d+$/.test(data.runtimeVersion) ||
        data.version !== deps.expectedVersion || !paths.release.endsWith(`v${data.version}-${data.sourceSha}`)) throw new Error();
    if (paths.platform === "win32") {
      const active = JSON.parse(decodeUtf8File(await readRecord(paths.current, 16384)));
      if (active.version !== data.version || active.sourceSha !== data.sourceSha) throw new CliError("INSTALLATION_CHANGED");
    } else if (decodeUtf8File(await readRecord(join(paths.release, ".command-bridge-release"), 256)).trim() !== data.sourceSha) throw new Error();
    installed = { version: data.version, sourceSha: data.sourceSha, runtimeVersion: data.runtimeVersion };
  } catch (error) { throw error instanceof CliError && error.code === "INSTALLATION_CHANGED" ? error : new CliError("INSTALLED_METADATA_INVALID"); }

  const issues: string[] = [];
  let values: Record<string, string> | null = null, saved = null;
  try {
    if (paths.platform === "win32" && service.configurationTrusted !== true) throw new CliError("CONFIGURATION_UNSAFE");
    await deps.trust(paths.config);
    values = parseSavedConfiguration(await readRecord(paths.config, 1048576));
  } catch (error) { issues.push(`CONFIGURATION_${readFailure(error)}`); }
  try {
    if (initial[4] !== "absent") {
      if (paths.platform === "win32" && service.descriptionTrusted !== true) throw new CliError("CLIENT_SETUP_UNSAFE");
      await deps.trust(paths.description);
      saved = parseClientSetup(await readRecord(paths.description, 16384));
    }
  } catch (error) { issues.push(`DESCRIPTION_${readFailure(error)}`); }
  if (service.state === "unknown") issues.push("SERVICE_STATUS_UNAVAILABLE");
  let connection = null;
  try { if (values && !issues.some(issue => issue.startsWith("DESCRIPTION_"))) connection = resolveConnection(values, saved, deps.hostname(), { name: flags.name, url: flags.url }); }
  catch { issues.push("LISTENER_INVALID"); }
  if (JSON.stringify(await Promise.all(tracked.map(fileIdentity))) !== JSON.stringify(initial)) throw new CliError("INSTALLATION_CHANGED");
  if (flags.operation === "setup") {
    if (!values || !connection || issues.some(issue => issue.startsWith("DESCRIPTION_"))) throw new CliError("SETUP_UNAVAILABLE");
    if (flags.showToken && !service.administrator) throw new CliError("ADMINISTRATOR_REQUIRED");
    const token = values.COMMAND_BRIDGE_BEARER_TOKEN;
    if (token && JSON.stringify(connection).includes(token)) throw new CliError("CONNECTION_CONTAINS_SECRET");
    return { output: renderCodexSetup(connection, flags.showToken ? values.COMMAND_BRIDGE_BEARER_TOKEN ?? "" : undefined), exitCode: 0 };
  }
  const enumValue = (key: string, allowed: string[], fallback: string) => {
    if (!values) return null;
    const value = values[key] ?? fallback;
    if (!allowed.includes(value)) { issues.push(`${key.replace("COMMAND_BRIDGE_", "")}_INVALID`); return null; }
    return value;
  };
  const boolValue = (key: string, fallback: boolean) => {
    if (!values) return null;
    if (values[key] === undefined) return fallback;
    if (!["true", "false"].includes(values[key]!)) { issues.push(`${key.replace("COMMAND_BRIDGE_", "")}_INVALID`); return null; }
    return values[key] === "true";
  };
  const auditBackend = enumValue("COMMAND_BRIDGE_AUDIT_BACKEND", ["auto", "journal", "eventlog", "file"], "auto");
  const workRoots = values?.COMMAND_BRIDGE_ALLOWED_ROOTS?.split(paths.platform === "win32" ? ";" : ":") ?? [];
  if (workRoots.length > 128 || workRoots.some(root => !root || root.length > 4096 || !(paths.platform === "win32" ? win32 : { isAbsolute: (s: string) => s.startsWith("/") }).isAbsolute(root))) throw new CliError("WORK_ROOTS_INVALID");
  const fileAudit = paths.platform === "linux" && service.account && service.account !== "command-bridge" ? "/var/lib/command-bridge-installer/CommandBridgeMCP/audit" : null;
  const report = {
    schemaVersion: 1, installed,
    locations: { application: paths.release, configuration: paths.config, clientSetup: paths.description, workRoots },
    service: { state: service.state, autoStart: service.autoStart, account: service.account },
    executionMode: enumValue("COMMAND_BRIDGE_EXECUTION_MODE", ["allowlist", "guarded", "unrestricted"], "allowlist"),
    connection, tokenStatus: values === null ? "unavailable" : values.COMMAND_BRIDGE_BEARER_TOKEN ? "configured" : "missing",
    audit: { backend: auditBackend, location: auditBackend === "file" ? fileAudit : paths.platform === "linux" ? "journal:command-bridge.service" : "Application:CommandBridgeMCP", locationVerified: false },
    fileTransfer: { uploadEnabled: boolValue("COMMAND_BRIDGE_UPLOAD_ENABLED", false), downloadEnabled: boolValue("COMMAND_BRIDGE_DOWNLOAD_ENABLED", false) },
    managedUpdateEnabled: boolValue("COMMAND_BRIDGE_MCP_UPDATE_ENABLED", true),
    partial: issues.length > 0, issues
  };
  const token = values?.COMMAND_BRIDGE_BEARER_TOKEN;
  // Redact values before serialization: escaping must not hide a secret or break JSON.
  const redact = (value: unknown): unknown => typeof value === "string" ? token ? value.split(token).join("[REDACTED]") : value :
    Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)])) : value;
  const safeReport = redact(report) as typeof report;
  const output = flags.json ? JSON.stringify(safeReport, null, 2) + "\n" :
    Object.entries(safeReport).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") +
    "Service state is not a readiness, Audit or remote connectivity verification.\n";
  if (Buffer.byteLength(output, "utf8") > 65536) throw new CliError("OUTPUT_LIMIT");
  return { output, exitCode: report.partial ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let timer: NodeJS.Timeout;
  const work = async () => {
    const flags = parseManagementArgs(process.argv.slice(2));
    if (flags.help) return { output: help, exitCode: 0 };
    return runInstalledManagement(process.argv.slice(2), installedPaths(resolve(dirname(fileURLToPath(import.meta.url)), "../..")));
  };
  Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CliError("QUERY_TIMEOUT")), 5000); })])
    .then(result => { clearTimeout(timer); process.stdout.write(result.output, () => process.exit(result.exitCode)); })
    .catch(error => { clearTimeout(timer); const code = readFailure(error); process.stderr.write(`CommandBridge query: ${code}\n`, () => process.exit(error instanceof CliError ? error.exitCode : 1)); });
}
