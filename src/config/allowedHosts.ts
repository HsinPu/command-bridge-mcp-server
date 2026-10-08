import { isIP } from "node:net";

/** Same hostname-only comparison as the SDK; ports do not authorize listeners. */
export function normalizeAllowedHosts(value: string | string[] | undefined): string[] {
  const entries = Array.isArray(value) ? value : (value ?? "").split(",");
  return [...new Set(entries.map(entry => entry.trim()).filter(Boolean).map(normalizeAllowedHost))];
}

function normalizeAllowedHost(entry: string): string {
  const invalid = () => new Error("COMMAND_BRIDGE_ALLOWED_HOSTS must contain hostnames or IP addresses with an optional port (1-65535), without URLs, credentials, paths or wildcards.");
  // Accept unbracketed IPv6 only as an address, never guess an IPv6 port.
  if (isIP(entry) === 6) entry = `[${entry}]`;
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::([0-9]{1,5}))?$/.exec(entry);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) throw invalid();
  try {
    const url = new URL(`http://${entry}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalid();
    return url.hostname;
  } catch { throw invalid(); }
}

/** Canonical authority for the SDK's Node-to-Request adapter (including port). */
export function normalizeHostHeader(value: string): string {
  if (isIP(value) === 6) throw new Error("IPv6 Host headers require brackets.");
  normalizeAllowedHost(value);
  return new URL(`http://${value}`).host;
}
