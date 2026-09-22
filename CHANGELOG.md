# Changelog

## 0.3.1 — 2026-09-22 (unreleased)

Patch release from 0.3.0: repairs the existing Windows installation flow without changing the MCP interface or adding a new installation mode.

- Document a one-line Windows PowerShell installation that downloads the pinned installer and source from GitHub without requiring Git or a preinstalled Node.js. Stop on download or installer failure and remove the temporary script afterward.
- Replace assignments to PowerShell's read-only Host variable in configuration generation and health checks.
- Add the downloaded Node.js runtime to PATH during build/test/prune and restore PATH afterward, including on failure.
- Count audit verification results as arrays so zero or one matching event works under StrictMode.
- Preserve LF line endings for the fixed Linux audit reader on Windows checkouts so its pinned checksum and the installation test suite remain valid.
- Synchronize package, MCP server, installer source references, and installation documentation to 0.3.1. Remote installation requires publishing tag v0.3.1 first.
