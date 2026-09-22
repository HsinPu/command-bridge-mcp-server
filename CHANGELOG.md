# Changelog

## 0.4.0 — 2026-09-22 (unreleased)

Minor release from 0.3.1: adds automatic IP-based connection setup while preserving existing installations and explicit HTTPS URLs.

- Fresh installations without an explicit URL or listener override select a private IPv4 address, preferring a default-route interface, and set the listener and allowed Host together. Supported ranges are RFC1918 and 100.64.0.0/10 (including Tailscale); no match falls back to loopback.
- Print the actual configured HTTP listener address and port in the Codex setup block without prompting for a URL. Existing configuration and tokens are preserved; explicit HTTPS URLs keep the loopback default for fresh installations.
- Generated HTTP URLs are for trusted LAN/VPN use. TLS and firewall rules are not provisioned. DHCP address changes require updating listener, allowed hosts, and client URL.
- Simplify both READMEs to one-command installation and uninstall for Windows/Linux; keep advanced details in deployment guides.
- Remote commands require publishing tag v0.4.0 first.

## 0.3.1 — 2026-09-22 (unreleased)

Patch release from 0.3.0: repairs the existing Windows installation flow without changing the MCP interface or adding a new installation mode.

- Document a one-line Windows PowerShell installation that downloads the pinned installer and source from GitHub without requiring Git or a preinstalled Node.js. Stop on download or installer failure and remove the temporary script afterward.
- Replace assignments to PowerShell's read-only Host variable in configuration generation and health checks.
- Add the downloaded Node.js runtime to PATH during build/test/prune and restore PATH afterward, including on failure.
- Count audit verification results as arrays so zero or one matching event works under StrictMode.
- Preserve LF line endings for the fixed Linux audit reader on Windows checkouts so its pinned checksum and the installation test suite remain valid.
- Synchronize package, MCP server, installer source references, and installation documentation to 0.3.1. Remote installation requires publishing tag v0.3.1 first.
