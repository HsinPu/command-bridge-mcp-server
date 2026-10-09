import { isIP } from "node:net";
import { parse } from "dotenv";
import { decodeUtf8File } from "../services/textEncoding.js";

export interface ClientSetup {
  schemaVersion: 1;
  connectionName: string;
  urlMode: "listener" | "explicit";
  explicitUrl: string | null;
  advertisedHost: string | null;
}

export class CliError extends Error {
  constructor(public readonly code: string, public readonly exitCode = 1) { super(code); }
}

export function parseSavedConfiguration(bytes: Uint8Array): Record<string, string> {
  try {
    if (bytes.byteLength > 1024 * 1024) throw new Error();
    return parse(decodeUtf8File(bytes));
  } catch { throw new CliError("CONFIGURATION_INVALID"); }
}

export function connectionName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new CliError("CONNECTION_NAME_INVALID", 2);
  return value;
}

export function defaultConnectionName(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "host";
  return `cb_${normalized.slice(0, 61)}`;
}

export function httpsConnectionUrl(value: string): string {
  try {
    if (value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash ||
        !/\/mcp\/?$/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new CliError("CONNECTION_URL_INVALID", 2); }
}

export function listenerHost(value: string): string {
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f]/.test(host) ||
      (!isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(host))) throw new CliError("LISTENER_INVALID");
  return host;
}

export function parseClientSetup(bytes: Uint8Array): ClientSetup {
  try {
    if (bytes.byteLength > 16 * 1024) throw new Error();
    const value = JSON.parse(decodeUtf8File(bytes));
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !==
        "advertisedHost,connectionName,explicitUrl,schemaVersion,urlMode" || value.schemaVersion !== 1 ||
        typeof value.connectionName !== "string" || !["listener", "explicit"].includes(value.urlMode)) throw new Error();
    connectionName(value.connectionName);
    if (value.urlMode === "explicit") {
      if (typeof value.explicitUrl !== "string") throw new Error();
      httpsConnectionUrl(value.explicitUrl);
    } else if (value.explicitUrl !== null) throw new Error();
    if (value.advertisedHost !== null) {
      if (typeof value.advertisedHost !== "string") throw new Error();
      listenerHost(value.advertisedHost);
      if (["0.0.0.0", "::"].includes(value.advertisedHost)) throw new Error();
    }
    return value as ClientSetup;
  } catch { throw new CliError("CLIENT_SETUP_INVALID"); }
}

export function createClientSetup(previous: ClientSetup | null, hostname: string,
  options: { name?: string; url?: string; advertisedHost?: string }): ClientSetup {
  const explicitUrl = options.url ? httpsConnectionUrl(options.url) : previous?.explicitUrl ?? null;
  return {
    schemaVersion: 1,
    connectionName: options.name ? connectionName(options.name) : previous?.connectionName ?? defaultConnectionName(hostname),
    urlMode: explicitUrl ? "explicit" : "listener",
    explicitUrl,
    advertisedHost: options.advertisedHost ? listenerHost(options.advertisedHost) : previous?.advertisedHost ?? null
  };
}

export function resolveConnection(values: Record<string, string>, saved: ClientSetup | null, hostname: string,
  options: { name?: string; url?: string } = {}) {
  const host = listenerHost(values.COMMAND_BRIDGE_HTTP_HOST ?? "127.0.0.1");
  const portText = values.COMMAND_BRIDGE_HTTP_PORT ?? "8800";
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new CliError("LISTENER_INVALID");
  const authority = (h: string) => isIP(h) === 6 ? `[${h}]` : h;
  const listenerUrl = `http://${authority(host)}:${Number(portText)}/mcp`;
  const advertised = host === "0.0.0.0" ? saved?.advertisedHost ?? "127.0.0.1" : host === "::" ? "::1" : host;
  const explicit = options.url ? httpsConnectionUrl(options.url) : saved?.explicitUrl;
  return {
    connectionName: options.name ? connectionName(options.name) : saved?.connectionName ?? defaultConnectionName(hostname),
    listenerUrl,
    connectionUrl: explicit ?? `http://${authority(advertised)}:${Number(portText)}/mcp`,
    urlSource: options.url ? "override" : explicit ? "savedHttps" : "listener",
    generatedFallback: saved === null,
    localOnly: !explicit && (advertised === "localhost" || advertised === "::1" || advertised.startsWith("127."))
  };
}

export function renderCodexSetup(connection: ReturnType<typeof resolveConnection>, token?: string): string {
  if (token !== undefined && !/^[A-Za-z0-9._~-]{32,}$/.test(token)) throw new CliError("TOKEN_INVALID");
  const name = connection.connectionName;
  const tokenEnv = `${name.toUpperCase()}_TOKEN`;
  const lines = [
    token ? "SECURITY WARNING: The block below contains a bearer token." : "Token is hidden. Use setup --show-token from an administrator terminal for the complete block.",
    "========== BEGIN COPY FOR CODEX ==========",
    `Configure a user-scoped MCP connection named ${name} on this Codex client.`,
    `MCP URL: ${connection.connectionUrl}`,
    `Codex connection name: ${name}`,
    `Token environment variable: ${tokenEnv}`,
    ...(token ? [`Bearer token (secret): ${token}`] : []),
    ...(connection.connectionUrl.startsWith("http:") ? [
      "This HTTP URL comes from the saved listener configuration; it does not provide TLS.",
      "Use it only over a trusted LAN or VPN. Firewall rules are not changed automatically."
    ] : ["This is the configured external HTTPS URL; this query does not verify the proxy or TLS route."]),
    ...(connection.localOnly ? ["This loopback URL works only on this host."] : []),
    ...(connection.generatedFallback ? ["No saved client description exists. Previous custom names or HTTPS URLs cannot be recovered automatically."] : []),
    "1. Inspect the existing user-level ~/.codex/config.toml and user environment.",
    "   If this name or token variable belongs to another host, choose an unused name and its uppercase NAME_TOKEN variable.",
    "   Never overwrite the existing connection or its token.",
    `2. Store this host's token in the user environment variable ${tokenEnv}; never store it in the repository or TOML.`,
    "3. Add this user-level Codex configuration:",
    `[mcp_servers.${name}]`,
    "enabled = true",
    `url = ${JSON.stringify(connection.connectionUrl)}`,
    `bearer_token_env_var = ${JSON.stringify(tokenEnv)}`,
    "startup_timeout_sec = 20.0",
    "tool_timeout_sec = 360.0",
    "4. Preserve unrelated settings and report whether Codex needs a restart.",
    `5. After restart, use /mcp to verify that ${name} is connected.`,
    "6. Do not repeat the bearer token in the final response.",
    "========== END COPY FOR CODEX ==========",
    ""
  ];
  return lines.join("\n");
}
