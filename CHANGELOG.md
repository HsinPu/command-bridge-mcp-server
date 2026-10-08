# Changelog

## 6.0.5 — 2026-10-08

PATCH: fix Windows installer false failures when running inside the managed-update worker with redirected native streams. Command policies, Audit enforcement, deployment verification and production deadlines are unchanged.

- Keep native stderr visible without promoting informational/expected diagnostic output to a PowerShell 5.1 terminating error. Temporarily adjust preference only around the native invocation, restore it in `finally`, and require a real zero native exit code.
- Reset/read PowerShell's global native exit variable so a missing executable cannot reuse a previous success and a function-local variable cannot hide the actual exit code.
- Reproduce the original failure in a private actual worker/bootstrap/installer process chain. Verify both `.exe` and npm-style `.cmd` diagnostic stderr with exit zero, nonzero exits and a missing executable; preserve stdout/stderr and the original caller preference.
- Record 6.0.4 Windows service success followed by source-test interruption, and keep every general/service/layout/channel gate intact.

## 6.0.4 — 2026-10-08

PATCH: correct CI managed-update failure diagnosis, which previously inspected Linux messages even on Windows. Runtime update behavior and all release gates are unchanged.

- Summarize the private worker log against the actual platform's installer/bootstrap sources, reporting only numeric message indices, bounded script locations, fixed stage/error categories and failure counts.
- Add a regression proving Windows/Linux classification, bounded locations and exclusion of tokens, paths, command text and raw errors. Do not expose the worker log or alter the MCP diagnostics schema.
- Record the actual Windows service installation success followed by managed-update failure; this diagnostic correction does not claim the update failure is resolved or installation-channel publication has succeeded.

## 6.0.3 — 2026-10-08

PATCH: fix a Linux recovery test dependency exposed by real installer service validation; production deployment, command policies and release gates are unchanged.

- Run the private uninstall/purge recovery regression with the installer's restricted `/usr/bin:/bin` PATH. Simulate absent identity tools inside that fixture and fail any unexpected deletion call, rather than depending on host sbin tools or touching host accounts.
- Emit fixed scenario/line/exit metadata on recovery fixture failure. Keep complete backup, preserved data, unsafe-purge rejection and activation/fault evidence assertions.
- Record 6.0.2 hosted general-test success and the Linux service/layout source-build failure. Update current version examples and guides without changing bootstrap commands or relaxing installer validation.

## 6.0.2 — 2026-10-08

PATCH: stabilize Windows PowerShell Shell source transport and built-in file cmdlet loading while retaining command policies, input/output fields and existing production deadlines.

- Pass Windows PowerShell Shell source through a private child environment value to a fixed ASCII entry command, clear the value before user code runs, and retain Unicode, quotes, the existing 20,000-character input limit and explicit exit codes. Native allowlist argv and Linux Shell invocation remain unchanged.
- Load the fixed built-in Management module explicitly when using the default module path. Keep explicitly authorized `PSModulePath` passthrough and clear reserved internal environment values case-insensitively.
- Add real Windows long-source/error/exit/environment and custom module-discovery regressions. Expand failure-only CI probes to isolate engine initialization, UTF-8 prefix, module loading, Unicode directories and source transport using private fixtures and fixed stage metadata only.
- Record the remaining 6.0.1 hosted PowerShell read timeout and skipped service/channel gates; no command/Audit deadline or publication requirement is relaxed.

## 6.0.1 — 2026-10-08

PATCH: fix Windows termination/PowerShell reliability and missed UTF-8 configuration validation without changing the MCP interface, encoding choices, policies or production time limits.

- Wait within the existing five-second termination deadline for both process exit and captured pipe closure after taskkill finishes. Accept a nonzero tool result only with that independent completion evidence; a live process or pipe still fails, and command slots/Audit remain bounded.
- Use the fixed Windows PowerShell executable and built-in module path by default; preserve explicitly authorized module-path passthrough. File Audit uses filtered Windows helper environment and .NET ACL constructors with module autoload disabled, retaining current-user-only ACLs and the five-second Audit deadline.
- Match dotenv/config's exported CLI option parser, including CLI precedence, last-value-wins and empty environment defaults, before checking the actual UTF-8 file. Explicit legacy encoding overrides remain supported; no input bytes are rewritten.
- Apply the requested Linux install mode even to an empty existing configuration, with exact empty-file rollback. Preserve the existing nonempty BOM/newline behavior.
- Add regression evidence for CLI validation bypasses, Windows termination races/live pipes and caller-module exclusion; improve Windows/MCP failure diagnostics without logging settings, tokens or captured command output. Keep CI/service/channel release gates unchanged.

## 6.0.0 — 2026-10-08

MAJOR: stop silently substituting invalid command output. Existing non-UTF-8 program calls now need `outputEncoding` set to their actual encoding, and incomplete/invalid text no longer returns a successful result containing replacement characters. cmd Shell execution now uses a UTF-8 console; cmd text redirection can therefore differ from legacy code pages. Tool names, existing fields, result schema and policies remain intact; valid UTF-8 calls require no changes.

Migration: update clients and service together; select `big5`, `gbk`, `gb18030` or `utf16le` for known legacy program output. Do not append cmd UTF-8 text to existing files in another encoding. Use explicitly configured file encodings, validated candidates and original-byte backups; repair invalid managed UTF-8 configuration/Audit data rather than guessing or overwriting it. The selector only decodes output and does not set file encoding. See `docs/text-encoding.md`.

- Add `outputEncoding=utf8|utf16le|big5|gbk|gb18030`, with independent streaming decoders for stdout/stderr. Reject invalid or incomplete output, withhold both streams, record one failed Audit and release the process slot; retain deadlines, truncation and Audit gating. Do not guess encodings or transcode file contents.
- Host Windows cmd Shell execution in a fixed UTF-8 PowerShell console and forward both raw byte streams, preserving cmd quoting, arguments and exit codes. Native allowlist programs still spawn directly. Handle a taskkill/natural-exit race only when process exit and captured stream completion are confirmed.
- Read Windows configuration strictly as UTF-8, preserve optional BOM and original line endings during targeted changes, snapshot/restore raw bytes, and treat path replacement values literally. Reject invalid managed UTF-8 before dotenv/policy parsing or installer rewrites; support BOM in installation probes. Retain explicitly configured legacy dotenv encodings.
- Preserve Linux configuration BOM, Chinese comments/paths, CRLF/LF and final-newline state during reinstall; teach saved-value readers to handle BOM/CRLF. Keep verified binary rollback snapshots.
- Emit Windows Audit/helper/installer output as UTF-8, read update JSON explicitly as UTF-8, reject invalid fixed-helper/file Audit text, and retain both platforms' update-log tails at UTF-8 character boundaries.
- Add real Windows command/file/configuration/Audit-reader regressions, cross-platform MCP command tests, Linux full-file configuration/transfer round trips, legacy-codec byte-boundary cases and source encoding checks. Add bilingual README guidance and a detailed UTF-8/file-integrity guide; no blanket file conversion, new privileges or weakened CI/channel gates.

## 5.0.1 — 2026-10-08

PATCH: repair confirmed Linux backup/rollback failures, UTF-8 stream decoding, Windows cmd quoting and accepted Host configuration. Existing MCP tools, policies, defaults and deployment paths are unchanged.

- Publish configuration, service-unit and Audit/helper snapshots only after complete copy, byte verification and recorded ownership/mode/digest. Track original absence and actual modification separately; a missing or partial backup must not overwrite/delete intact originals.
- Restore files atomically on the destination filesystem; explicitly propagate file, label, CLI/layout and systemd errors, including functions invoked in Bash conditional contexts. Do not restart after incomplete recovery. Retain minimal private snapshots in `/var/lib/command-bridge-recovery`; refuse further installation until administrator recovery. Ordinary uninstall preserves these records, verified purge removes them, and old uninstall helpers defer to the verified channel when recovery validation is required.
- Decode command stdout/stderr and fixed Audit/update/diagnostic helper output across UTF-8 chunk boundaries. Keep separate streams, output limits, deadlines and terminal Audit gating.
- Pass cmd Shell text with the correct `/d /s /c` outer quoting and Windows verbatim arguments; keep native allowlist argv and PowerShell execution unchanged.
- Normalize allowed Host ports, DNS case and IPv6 consistently for runtime and installation probes. Canonicalize valid incoming Host authorities for the SDK adapter; reject malformed values while retaining Host/Bearer checks.
- Add private filesystem failure regressions, native process/HTTP tests and both-account real-service recovery fault checks without production fault flags. Keep every CI/channel publication gate; hosted service validation and publication require actual CI success.

## 5.0.0 — 2026-10-08

MAJOR: remove historical Linux program paths completely after verified migration, without compatibility symlinks. Scripts that reference `/opt/command-bridge` or `/opt/command-bridge-mcp-server` must use `/usr/local/lib/command-bridge` or the managed `command-bridge` CLI.

- Inspect protected service/fixture work directories with the existing `sudo test` permission instead of mistaking a traversal denial for a missing directory.
- Report fixed mode/stage and line-number context on layout-smoke failures without command text, configuration or tokens.
- Remove both old program roots, their managed migration backups and aliases left by 4.6.x after successful verification. Keep the original deployment until activation succeeds; restore the original directories and alias targets on failure. Configuration, Token, work and Audit/update data are retained.
- Require one administrator-terminal migration for deployments physically under `/opt`. A legacy MCP worker caches the old path, so reject its relocation before host changes and record a failed job with the original SHA/service intact. Once migrated, MCP updates continue normally and also remove leftover 4.6.x aliases.
- Verify real services in both account modes, with an ordinary sudo caller, legacy-worker rejection, terminal migration, subsequent MCP update, rollback and complete uninstall. Require old program paths to be absent; retain all CI/channel publication gates.
- Synchronize version examples, project guidance and validation evidence; retain every cross-platform service/layout publication gate.

## 4.6.2 — 2026-10-08

PATCH: fix Linux alias-parent validation and uninstall preflight ordering; preserve valid managed deployments, MCP interfaces and fixed installation entry points.

- Validate each compatibility alias's original parent ownership and permissions during installation and uninstall. Bootstrap checks existing program/backup parents, lexical saved-asset ancestors and canonical targets, and executes the verified canonical saved script/runtime.
- Replace legacy saved uninstallers with the CI-pinned full-layout uninstaller before any service stop or removal. Refuse an older downloaded uninstaller that lacks full-layout validation, or a missing/invalid modern helper, without changing the installed service. Keep offline legacy help, safe previews and channel error handling.
- Add private filesystem regressions for unsafe aliases, foreign/mounted/writable roots, fallback failures, preview/data preservation and successful pinned cleanup. Extend both real Linux service-account scenarios to prove unknown new roots leave the old service, source identity, configuration, updater, work and authenticated MCP/Audit intact.
- Synchronize both READMEs, platform/migration guides, project rules and validation evidence; no source publication is claimed before CI succeeds.

## 4.6.1 — 2026-10-08

PATCH: close Linux migration, self-protection and uninstall reliability gaps without changing supported MCP interfaces or installation entry points.

- Prepare `/opt` and the new `/usr/local` parents consistently in guarded disposable Linux service tests; keep production ownership/write-permission rejection unchanged. Cover writable old/new parents and refusal outside the disposable Linux environment.
- Include all three fixed `.migration-backup` program roots in direct self-modification protection. Cover literal writes/deletion, read access, similarly named unrelated directories and attempted/blocked Audit lifecycles without destructive test commands.
- Use the CI-pinned uninstall fallback when a saved modern uninstaller is present but its required `layout.sh` is absent, including help/dry-run. Reject existing unsafe helpers, dangling/escaping links and unsafe parents before download or execution; keep channel errors fail-closed.
- Add missing-helper service-uninstall coverage and synchronize both READMEs, platform/migration guides, project rules and validation evidence.

## 4.6.0 — 2026-10-08

MINOR: introduce the compatible Linux program layout and automatic migration while preserving existing operation entry points, MCP interfaces and saved configuration/data.

- Default application/runtime deployment to `/usr/local/lib/command-bridge`; detect both historical `/opt` roots and stage cross-filesystem copies before switching. Keep originals until real service verification, restore unit/configuration/CLI/readers/updater on failure, and retain exact compatibility aliases only for existing installations.
- Make bootstrap updates resolve known installed roots, permit the old independent MCP worker to finish relocation, and save layout metadata with the version/source SHA. Validate protected parents, ownership, managed identities, pointers, mounts and destination free space.
- Uninstall checks every known root and managed backup, removes verified program leftovers and aliases together, and verifies absence. Continue cleanup after older saved uninstallers through one CI-pinned fallback when needed; preserve default data and installer login accounts.
- Add physical migration/rollback/removal regressions and a separate real Linux service gate for dedicated/installer identities, activation evidence, old MCP-worker migration and uninstall fallback; retain cross-platform publication gates. Update both READMEs, operating guides and project rules.
- Correct the diagnostic asset fixture for the installer's minimal build-account PATH and non-root restoration of read-only fixture files; retain production ownership and permission checks.

## 4.5.0 — 2026-10-07

MINOR: add a compatible, default-enabled read-only MCP diagnostics tool while preserving existing command, transfer and update authorization.

- Add `command_bridge_get_diagnostics` with bounded volatile command summaries, first Audit failure metadata, actual Audit I/O/queue counts, fixed service/storage probes, optional exact Audit ID filtering and a 1–100 summary limit (20 default). No command text, output, secrets, arbitrary paths or raw logs are returned.
- Keep diagnostics independent of the failed Audit sink, coalesce actual pending probes, cap responses at 64 KiB and five seconds, and cache completed probes for two seconds.
- Permit diagnostic-only startup only after non-Audit dependencies pass; retain authenticated HTTP access and failing readiness. Commands, transfers and new updates continue to fail closed. Installation still requires real readiness/MCP/Audit and fixed-reader verification.
- Provision a pinned root-owned no-argument Linux diagnostic reader with an exact numeric-UID sudo rule, SELinux labeling and transactional rollback/removal. Stage the fixed read-only Windows script with application ACLs; no new Windows elevation broker.
- Cover protocol authentication, native readers, privacy, timeouts, coalescing, Audit failures, real startup and deployment assets; synchronize operating guides and project rules. Hosted service/rollback/release validation remains pending push and CI.

## 4.4.7 — 2026-10-07

PATCH: increase the existing Audit query capacity without changing tool inputs, defaults or result shape.

- Raise the maximum `limit` from 100 to 1,000, retaining the default of 50 and rejecting invalid/out-of-range values consistently across backends.
- Update Windows/journal reader windows to 1,001 records and remove the file backend's former 100-event clamp; retain helper authorization, deadlines, byte limits and secret masking.
- Cover MCP validation, ordering, boundary/hasMore behavior, rotated files and fixed native readers; synchronize both READMEs and platform guidance.

## 4.4.6 — 2026-10-07

PATCH: capture Windows native installer streams without treating stderr as a PowerShell exception.

- Run the fixed bootstrap through a hidden .NET process, drain stdout/stderr concurrently and determine success from the actual exit code.
- Retain private diagnostic capture and unchanged service/rollback/publication verification.
- Add native regressions for benign stderr and nonzero exit status.

## 4.4.5 — 2026-10-07

PATCH: correct Windows PowerShell atomic record replacement and update integration-test baselines.

- Pass an explicit null string to File.Replace; native lifecycle tests cover repeated replacement and Audit failure preventing state publication.
- Refresh Linux rollback expectations after an intentional different-SHA reinstall; require a second real MCP update under the installer-account identity.
- Block recognizable direct PowerShell/Schtasks updater triggers while retaining readonly task queries.
- Verify uninstall/purge updater retention and recursively restore labels only on protected updater program assets.

## 4.4.4 — 2026-10-07

PATCH: avoid slow/user-controlled PowerShell module discovery in updater scripts.

- Load only the fixed system Utility/Management modules before using their cmdlets, retaining the existing 15-second control deadline.
- The native regression runs the actual common-module initialization while isolating OS task access; no timeout or service/publication check is weakened.

## 4.4.3 — 2026-10-07

PATCH: make managed program assets readable after builds with restrictive updater umask; retain private configuration/data permissions.

- Normalize only physical managed Runtime/release assets, including reused deployments, without following symlinks or widening configuration/work-data access.
- Reuse the existing restricted Windows Audit environment for PowerShell control; add native request-script and strict-umask regression tests.
- Keep service activation/readiness and publication gates mandatory.

## 4.4.2 — 2026-10-07

PATCH: supply deterministic Windows control environment defaults and strict numeric request diagnostics.

- Report only validated control stage/HResult/line values, rejecting additional fields and never exposing child stderr.
- Keep installer diagnosis numeric through fixed source-error indices and curl exit codes; preserve all publication gates.

## 4.4.1 — 2026-10-07

PATCH: improve bounded updater control and administrator-only failure diagnostics after the first hosted service checks rejected publication.

- Bound the Linux task-start helper and retain capped private worker logs without exposing them through MCP or CI output.
- CI reports only numeric worker error locations, OS result codes, test indices and a fixed errno vocabulary; no raw log/configuration text is exported.
- Publication remains blocked until both real service gates pass; no execution policies or source checks are relaxed.

## 4.4.0 — 2026-10-07

MINOR: adds compatible, default-enabled MCP service-update and status tools without changing existing tools or execution modes.

- Provision a fixed root systemd worker / SYSTEM scheduled task outside the application deployment, with no caller-supplied source or command arguments.
- Update only the pinned verified CI channel through existing deployment locks, validation and rollback; retain safe job metadata across service restarts.
- Audit each acceptance request and worker lifecycle; honor saved disable settings independently, serialize jobs and protect updater assets from direct command modification.
- Remove updater authorization/assets on uninstall, retain job records unless purging, and add real service-update/failure/disable CI checks.

## 4.3.3 — 2026-10-07

PATCH from 4.3.2: make disposable startup-failure evidence idempotent across service restart attempts. Preserve the first valid SHA/stage/fault marker and keep emitting the designated failure instead of EEXIST; reject mismatched evidence. Retain stale-marker preflight and both fault/evidence assertions. Add repeated-startup and mismatched-marker regressions; production behavior and publication gates are unchanged.

## 4.3.2 — 2026-10-07

PATCH from 4.3.1: preserve the real entry point and its early version arguments in disposable health-failure snapshots. Inject failure only during server startup for the exact deployed SHA, leaving source/other-SHA runs and version queries unaffected. Version queries cannot produce activation evidence. This fixes the hosted rollback case failing before service activation; no production validation bypass is introduced.

## 4.3.1 — 2026-10-07

PATCH from 4.3.0: preserve source manifests while pruning development dependencies with --no-save, so repeated managed installation does not fail the clean-source guard. Reproduce and verify source preservation with an offline disposable npm fixture. Prepare the disposable Linux service runner CLI parent as root-owned/non-writable without relaxing production checks. Give Windows mutex tests unique names so installer-held production locks do not block their own build tests. Verified 4.2.0 CI failed at the Linux unsafe parent check and Windows clean-source check; channel publication was correctly skipped.

## 4.3.0 — 2026-10-07

MINOR from 4.2.0: add service-installed `command-bridge update` and `update --check`, comparing full source SHA against the verified CI channel. Use locally saved bootstrap assets, pin one snapshot, preserve complete configuration and service identity, require administrator privileges for changes and retain existing service/MCP/Audit verification and rollback. Detect installation changes under the deployment lock; serialize Windows installation/removal with a shared mutex. Keep checks read-only and Token output opt-in, clean temporary files after failures, and block recognizable direct MCP self-updates. npm installs continue to use npm. Add disposable update/channel/account/cleanup/lock tests and hosted service update/rollback cases.

## 4.2.0 — 2026-10-07

MINOR from 4.1.16: add --version/-V before configuration, Audit or transport initialization, and a compatible command-bridge npm bin alias. Linux installs a root-managed /usr/local/bin/command-bridge symlink following the active release, validates collisions/parent permissions, restores labels, verifies output before committing activation and rolls back new entries; uninstall preserves unrelated entries. Windows installs a bundled-runtime command-bridge.cmd without modifying PATH. Protect the Linux entry from direct MCP self-modification. Document installed-version semantics and migration; retain existing server startup with no arguments and the long npm name.

## 4.1.16 — 2026-10-07

PATCH from 4.1.15: release each command execution slot when its process settles, independently of terminal Audit completion. Bound shared Audit write/read waits (including queue time) to five seconds and cap outstanding Audit operations at 64. Fail closed after an Audit failure: do not start new commands/transfers, expose output or silently resume after late I/O; queued expired operations never start. Track actual unfinished Audit I/O during the existing 15-second shutdown budget, and bound/coalesce readiness probes. Add controlled-stall, admission, slot-release, output-withholding and real HTTP/MCP readiness regressions. Docker and process-tree termination policies remain unchanged.

## 4.1.15 — 2026-10-07

PATCH from 4.1.14: raise the configurable default command maximum from 60 to 300 seconds and print a 360-second Codex tool deadline on both platforms, leaving the ordinary 15-second default and explicit existing timeout settings unchanged. Document existing-install migration and the required long-command timeoutMs. Add configuration and generated-setup regressions; do not change Audit, cancellation or process termination deadlines.

## 4.1.14 — 2026-10-01

PATCH from 4.1.13: assign Administrators ownership to the installer-managed Windows configuration parent and recognize the fixed privileged TrustedInstaller SID only for transfer ancestors (Windows volume roots use this owner). Keep transfer-root ownership limited to SYSTEM/Administrators and retain non-administrator write/delete/ACL checks. Extend the native installer ACL regression to verify managed-parent ownership. The early real LocalService probe identified FILE_ROOT_UNSAFE:owner instead of failing late with a generic upload error.

## 4.1.13 — 2026-10-01

PATCH from 4.1.12: canonicalize the Windows unsafe-root test's temporary directory before requesting upload. Hosted TEMP uses an 8.3 RUNNER~1 alias, so the stricter regression was stopped by the earlier canonical-path check instead of exercising ACL rejection. Preserve production path restrictions and require a real owner/readable/writable ACL result; keep early LocalService transfer verification and full release gates.

## 4.1.12 — 2026-10-01

PATCH from 4.1.11: query Windows transfer ACLs through .NET rather than Get-Acl auto-loading and retain all existing owner/access rules. Provide only fixed ACL failure categories and safe MCP error codes in file-transfer verification. Run the real LocalService file-transfer probe immediately after initial service setup, before longer lifecycle/rollback cases, while retaining the final post-reinstall probe. Hosted 4.1.10 reached real upload but its generic failure lacked an actionable category; publication remains blocked until the complete service gate passes.

## 4.1.11 — 2026-10-01

PATCH from 4.1.10: resolve the Windows directory-lease assembly from the application dist directory in both source and built execution. Prepare build assets through predev so npm run dev retains file-transfer support after moving interop compilation out of requests. Production deadlines, ACLs and MCP interfaces remain unchanged; preserve the full CI/service publication gate.

## 4.1.10 — 2026-10-01

PATCH from 4.1.9: read ACLs through the native .NET Directory API in the elevated Windows regression so inherited PowerShell 7 module paths cannot redirect Windows PowerShell Security module discovery. Hosted 4.1.9 successfully executed the production ACL sequence; the regression then failed only while auto-loading Get-Acl. Preserve all owner/inheritance/publication/deletion assertions and service release gates.

## 4.1.9 — 2026-10-01

PATCH from 4.1.8: grant explicit SYSTEM/Administrators full control before assigning the Windows transfer-directory owner and removing inherited permissions. The elevated native ACL regression caught owner assignment being denied after inheritance removal left no explicit administrator rights. Keep the same final protected ACL and LocalService publication rights, and retain the native regression and complete service publication gate.

## 4.1.8 — 2026-10-01

PATCH from 4.1.7: apply Windows transfer-directory inheritance removal and owner assignment in separate icacls calls; combining /inheritance:r with /setowner was rejected during real service installation. Retain the Administrators owner, SYSTEM/Administrators full control and LocalService directory/file rights. Add an elevated disposable-directory behavior test using the production ACL function to verify owner, protected inheritance and directory publication without deletion rights; explicitly skip when elevation is unavailable. Linux 4.1.7 service lifecycle and 1.x migration/rollback have passed hosted CI; keep the full Windows service validation gate before publication.

## 4.1.7 — 2026-10-01

PATCH from 4.1.6: deploy the file-transfer verifier alongside the installation verifier, and run guarded/file-transfer service smoke verifiers from the active deployed release on both platforms so they resolve its installed MCP SDK, rather than requiring dependencies in the source checkout. Resolve the Windows active release again after reinstall and verify copied Linux asset contents. Preserve real MCP/Audit assertions and all publication gates. Hosted 4.1.6 general tests passed on both platforms; Linux lifecycle exposed the missing checkout SDK before file-transfer verification.

## 4.1.6 — 2026-10-01

PATCH from 4.1.5: compile the fixed Windows directory-lease interop assembly during npm run build, then load it from the installed application at runtime. Hosted stage diagnostics confirmed .NET compilation exceeded the unchanged five-second request readiness deadline even with private TEMP/TMP. Remove request-time compilation instead of widening that deadline; retain native handle protection, failed-open cleanup tests and fail-closed behavior. Build failure stops deployment and the cross-platform release gate remains intact.

## 4.1.5 — 2026-10-01

PATCH from 4.1.4: supply the native Windows directory-lock helper with its own private TEMP/TMP directory for .NET compilation. Preserve the five-second readiness deadline and fail-closed transfer behavior. Report only safe startup/compile/open stage names on failure, never compiler output or paths; cover failed native opens and compiler-directory cleanup. Sequential Windows tests alone did not resolve hosted CI; installation publication remains gated by real cross-platform validation.

## 4.1.4 — 2026-10-01

PATCH from 4.1.3: run Windows test files sequentially to avoid concurrent cold PowerShell compiler startups exhausting the directory-lease readiness deadline on hosted CI. Keep the production five-second lock deadline, all safety assertions and Linux test concurrency unchanged. Synchronize current version references; guarded installation remains gated by cross-platform tests and real service validation.

## 4.1.3 — 2026-10-01

PATCH from 4.1.2: record the required automatic Git commit after each completed, versioned and validated batch in AGENTS.md. Synchronize current version references; runtime behavior and the guarded one-command installation choice remain unchanged.

## 4.1.2 — 2026-10-01

PATCH from 4.1.1: change the documented primary one-command installers to explicitly select guarded on Linux (--guarded) and Windows (-ExecutionMode guarded), including reinstalls. Synchronize README translations, platform guides and project rules; preserve tokens and other settings. This documentation/setup-preference update leaves local runtime and bare-installer defaults unchanged. Fixed bootstrap URLs and uninstall commands remain unchanged.

## 4.1.1 — 2026-10-01

PATCH from 4.1.0: fix guarded preflight bypasses for curl/wget compact output options and PowerShell named write targets. Resolve Path/LiteralPath/Destination/FilePath and colon-bound values independently of argument order; reject unsupported or ambiguous parameters rather than guessing. Preserve ordinary work-directory targets and system-source copies. Add harmless policy/executor regressions proving blocked Audit lifecycle and untouched files, and synchronize three-mode documentation. Existing modes, defaults, tool interfaces and sudo permissions are unchanged.

## 4.1.0 — 2026-09-30

MINOR from 4.0.0: add optional guarded execution mode while preserving allowlist defaults and unrestricted behavior. Guarded inspects common deletion commands, destructive synchronization options, system file writes, package/account/service/network/disk/registry/task changes and literal command chains before spawn. Unsupported expansion and complex syntax fail explicitly. Preserve existing sudo permissions and always-on MCP self-protection; arbitrary scripts/programs remain outside the guarantee.

Expose rule and Audit ID on guarded rejections, retaining attempted/blocked lifecycle and schemaVersion 1. Add Linux --guarded and Windows -ExecutionMode choices with preserved configuration backups; keep bootstrap primary commands unchanged. Add cross-platform behavior, MCP/Audit, configuration switch/rollback tests and disposable service probes; synchronize package, guides and validation records.

## 4.0.0 — 2026-09-30

MAJOR from 3.1.0: add an always-on command preflight guard that rejects recognizable direct writes to CommandBridge configuration, policy, application, Audit helper and service assets. Previously valid unrestricted self-maintenance commands now fail with `SELF_MODIFICATION_BLOCKED`, so administrators must perform those operations outside MCP. Preserve tool interfaces, existing sudo permissions, service-account modes and installer entry points; no privilege broker or OS sandbox is introduced.

Check common mutation commands, output redirections, literal nested Shell calls, relative/case-normalized paths, symlink/junction parents and destructive ancestor targets. Rejections happen before spawn and produce attempted/blocked Audit lifecycle events. Add cross-platform behavior tests and explicit bypass/false-positive documentation: scripts, variables, arbitrary program internals, filesystem races and external privileged services are not reliably contained. Synchronize versions, README files, platform guidance and validation records.

## 3.1.0 — 2026-09-30

MINOR from 3.0.0: add optional `command_bridge_upload_file` and `command_bridge_download_file` with independent default-disabled permissions, SHA-256/canonical Base64 validation and a maximum 5 MiB file size. Preserve existing tools and command policies; fix the optional absent Bearer Token schema for local stdio while retaining required HTTP authentication. Restrict transfers to private managed directories and flat filenames; reject links, special files, unsafe ACLs and existing destinations. First release deliberately does not support conditional overwrite because portable filesystem APIs cannot guarantee atomic compare-and-replace.

Anchor Linux operations to an open directory descriptor; protect Windows directory identity with verified ACLs and a native handle. Add bounded transfers, cancellation/cleanup, optional Audit metadata without content, authenticated bounded HTTP bodies, installer opt-in switches and real MCP/Audit service smoke probes. Synchronize configuration, README files and platform guidance. Hosted CI/service and installation-channel publication remain subject to actual verification.

## 3.0.0 — 2026-09-30

Major release from 2.2.4: Linux installation now always selects command execution mode from the current installer options. Without `--unrestricted` it writes `allowlist`, even when reinstalling a previously unrestricted deployment; explicit `--run-as-installer --unrestricted` writes `unrestricted`. Saved mode and inherited execution-mode environment values no longer select installation mode. Other configuration, tokens, network settings, roots and policies remain preserved, with rollback on validation failure.

**Migration:** users requiring unrestricted commands must pass `--unrestricted` on every install or upgrade. The README command now restores allowlist enforcement automatically. Default policies reject unlisted/deletion commands but are not a filesystem sandbox. MCP interfaces and Windows installation behavior are unchanged. Add behavior and service-switch tests, and synchronize both README files and platform guidance.

## 2.2.4 — 2026-09-30

Patch release from 2.2.3: remove unrestricted execution from both README Linux one-command installation entries. Fresh installations run as the installing account with the default command allowlist. Explain default rejection of deletion/unlisted commands, distinguish account permissions from command-policy authorization, and document how existing unrestricted installations explicitly return to allowlist mode. Saved configuration, installer defaults and runtime behavior remain unchanged.

## 2.2.3 — 2026-09-30

Patch release from 2.2.2: wrap Linux copy-ready install/uninstall commands in a subshell with EXIT cleanup so download or installation failures remove the caller-owned temporary bootstrap script without changing the caller shell traps. Track and clean only the current invocation's runtime/release staging directories on installer exit, preserving promoted releases, existing runtimes and rollback data. Continue temporary cleanup even when configuration restoration fails. Add failure-injection and cleanup-boundary behavior tests. Hard kills and power loss cannot run EXIT cleanup; no automatic deletion of old deployments is introduced.

## 2.2.2 — 2026-09-30

Patch release from 2.2.1: correct the English and Traditional Chinese README Linux copy-ready install commands to explicitly use the installing login account with unrestricted shell execution. Explain existing passwordless sudo permissions, file Audit, and how to select the dedicated-account or fresh allowlist alternatives. Clarify that removing an option on reinstall does not reset a saved execution mode. Installer defaults, MCP interfaces and runtime behavior are unchanged.

## 2.2.1 — 2026-09-30

Patch release from 2.2.0: stop creating the unused dedicated Linux user in installer-account mode. Keep the policy-reader group, and detect old local system accounts by UID, home, shell and group settings before removing the `command-bridge` user only after successful service/MCP/Audit verification. Never kill its processes or use `userdel -r`; preserve configuration, tokens and working data. Failed activation retains the old account for rollback; a final cleanup failure reports an error while keeping the newly verified service active. Default dedicated-account mode still creates its required service identity. Add account-validation and real-service regression cases, and make uninstall output reflect which identities actually exist.

## 2.2.0 — 2026-09-30

Minor release from 2.1.2: one-command Linux and Windows installers now print a Codex client connection name derived from the host name and a matching, connection-specific bearer-token environment variable. Multiple hosts can therefore be configured on one Codex client without reusing the former fixed `command_bridge` alias or `COMMAND_BRIDGE_BEARER_TOKEN` client variable. `--codex-name NAME` / `-CodexName NAME` optionally selects a stable client alias; these options affect only the printed setup block. The block tells Codex to inspect existing client settings and choose an unused alias and token variable when a different host already uses the suggestion, preserving existing connections. Service names, MCP tool names, server authentication and saved tokens are unchanged.

## 2.1.2 — 2026-09-29

Patch release from 2.1.1: complete rollback when an installer-account candidate fails before Audit reader assets were installed. The no-op Audit rollback now succeeds, allowing the prior release link, unit and service to be restored. Add a regression check for the no-op case; MCP interfaces, sudo policy and service defaults are unchanged.

## 2.1.1 — 2026-09-29

Patch release from 2.1.0: make the Windows Audit invalid-payload test tolerate slow PowerShell startup on hosted CI. The test process now has a 15-second launch budget and reports elapsed time on failure; the production Audit helper's five-second deadline, MCP behavior and Linux installer-account mode are unchanged.

## 2.1.0 — 2026-09-29

Minor release from 2.0.3: add an opt-in Linux service mode that runs as the original non-root account invoking the installer through sudo. Existing installations and the default dedicated-account mode keep their behavior.

- `--run-as-installer` uses the installing account's UID and groups, file Audit under `/var/lib/command-bridge-installer`, and its existing sudo policy. No broad sudoers grant is created; password-requiring sudo commands must use `sudo -n` and fail non-interactively.
- `--unrestricted` may be paired with `--run-as-installer` to explicitly enable free shell commands. Without it, the allowlist remains active. The installer-account unit does not apply the dedicated service's filesystem/capability restrictions, so commands can use the login account's normal access.
- Preserve the bearer token and other settings when changing modes, roll back service/configuration/Audit assets if activation fails, and keep the login account on uninstall and purge. Extend Linux behavior and disposable-service checks, including a real MCP sudo and matching Audit lifecycle.
- Recreate the Audit reader directory when restoring a dedicated-account installation after a failed switch to installer-account mode.

## 2.0.3 — 2026-09-29

Patch release from 2.0.2: fix SELinux label repair on Oracle Linux 8.10, whose `restorecon` does not accept `-x`. MCP interfaces, command policies, and deployment paths are unchanged.

- Traverse the managed deployment tree with `find -P -xdev` and invoke `restorecon` on discovered paths. Continue verifying each path with `matchpathcon` and stop activation if repair or verification fails.
- Make the SELinux installer test reject unsupported `restorecon` options, covering the Oracle Linux 8 failure before publication.

## 2.0.2 — 2026-09-29

Patch release from 2.0.1: fix Linux deployment SELinux contexts that caused systemd `203/EXEC` on Oracle Linux 8.10 Enforcing, without changing command policies or MCP interfaces.

- Do not preserve temporary contexts when copying runtime/application assets. Restore and verify final-path labels against host policy before activation, including reused runtimes from failed installs.
- Validate required tools on Enforcing/Permissive hosts; fail closed on labeling errors. Repair restored configuration, runtime, service and Audit asset labels before rollback restart, without recursively relabeling user work data or changing SELinux policy/mode.
- Add behavior tests for fresh/reused deployments, labeling failures, symlink/work-data boundaries and normal/legacy rollback. Add an explicitly opted-in disposable Enforcing VM test that reproduces `user_tmp_t`/203, repairs it, and checks real MCP/Audit and lifecycle behavior.
- Include restricted startup diagnostics and document retry prerequisites and verification limits. Full Oracle Linux 8.10 Enforcing validation is separately recorded; Ubuntu/Windows CI alone does not establish it.

## 2.0.1 — 2026-09-29

Patch release from 2.0.0: document the established Linux service and path naming rules for future changes, with no runtime behavior changes.

- Record the canonical Linux `command-bridge.service` and `/opt`, `/etc`, `/var/lib` locations, the unchanged repository/npm/Windows/MCP names, and the required 1.x migration, rollback and data-preservation checks in AGENTS.md.
- Synchronize package metadata, README version badges and current-version examples in the platform guide; clarify current and historical Linux policy paths in the migration guide. The fixed bootstrap URL and historical 2.0.0 migration record are unchanged.

## 2.0.0 — 2026-09-29

Major release from 1.0.5: the Linux systemd service and canonical application, configuration and state paths change from `command-bridge-mcp-server` to `command-bridge`. Existing scripts that reference the old service name must use `command-bridge`; the GitHub repository, npm package, MCP tools and Windows service are unchanged.

- New Linux installations use `/opt/command-bridge`, `/etc/command-bridge`, `/var/lib/command-bridge` and `command-bridge.service`.
- On upgrade, the installer validates the old configuration before switching services, moves the existing directories without replacing the token or working data, and keeps old directory names as links for existing absolute paths. A failed new-service activation moves the directories back and restores the old release and service.
- The bootstrap still uses the fixed repository URL and the CI-verified full source SHA. This version is not available through the public bootstrap until Windows/Linux CI and service validation publish its SHA to `install-channel`.
- Local Ubuntu WSL service checks passed for a fresh installation and a real 1.0.5 upgrade, including a forced post-activation failure, old-service recovery, MCP/Audit checks and purge. Hosted CI remains the publication gate.

## 1.0.5 — 2026-09-29

Patch release from 1.0.4: repair service deployment validation and recovery without changing MCP interfaces or command policies.

- Clear the failed candidate's systemd start-limit counter before restarting the restored release. Report a restored-service restart failure instead of silently discarding it.
- Report Linux smoke failure line and service state without printing configuration. Add Windows startup categories, listener/child-process presence and bounded log excerpts; redact the configured token and credential fields, and exclude Audit payloads, configuration and environment dumps.
- Suppress PowerShell download progress rendering while retaining checksum verification.
- Probe Windows service health directly without Internet proxy/WPAD, preserve the configured Host header and handle IPv6 listener URLs. Exercise the probe against a real local HTTP server.
- Preserve only standard Windows directory variables for Audit PowerShell helpers and load their trusted built-in modules explicitly; retain the five-second helper limit. Include rotated startup logs and safe Audit failure categories in diagnostics. Wait for restored Windows listeners before mandatory MCP/Audit checks.
- Local Windows validation passed 61/64 tests with three Linux skips; hosted Linux service lifecycle passed after the rollback fix. Full cross-platform service verification controls channel publication; see docs/validation-status.md and the CI run for the channel's source SHA. A version entry alone does not publish an installation snapshot.

## 1.0.4 — 2026-09-29 (unreleased)

Patch release from 1.0.3: fix Linux installation and native Audit startup without changing MCP interfaces or command policies.

- Isolate npm user/global configuration in distinct empty, build-account-owned files so npm accepts clean installation and pruning.
- Correct allowed Host validation for IPv4, hostname lists and bracketed IPv6; cover valid and invalid values with executable Bash tests.
- Allow an empty journal on first installation while propagating journal read failures. The fixed reader filters Audit JSON from the latest 1,000 service entries; unrelated service messages remain excluded.
- Permit only CAP_SETUID and CAP_SETGID in the service capability ceiling for the fixed sudo Audit reader, with no ambient capabilities for the service process. Keep exact no-argument sudo authorization and root-owned assets.
- Remove systemd settings that implicitly prohibit the required sudo transition. Retain filesystem/resource restrictions and use DevicePolicy=closed; document the unavailable syscall restrictions explicitly.
- Return success when optional Codex setup output is disabled, instead of reporting a completed installation as failed. Service smoke tests also check the real process has no effective or ambient capabilities.
- Bound service-test waits for the listener after Type=simple restarts before requiring authenticated readiness, real MCP and Audit verification; keep production timeouts unchanged.
- Validated the complete Linux service lifecycle locally on Ubuntu WSL with Node.js 24.18.0, including activation evidence, changed-network rollback and uninstall/reinstall/purge. Linux suites passed 58/62 (four Windows skips); Windows compatibility passed 59/62 (three Linux skips). Hosted CI and channel publication remain pending.

## 1.0.3 — 2026-09-29 (unreleased)

Patch release from 1.0.2: make Windows PowerShell startup more deterministic and improve CI failure diagnosis, without changing command policies or timeout budgets.

- Preserve standard Windows system/program/profile directory variables in the filtered child environment without inheriting unrelated secrets.
- Pin safe cmdlet module discovery to Windows PowerShell's own Modules directory, load required modules by absolute manifest path, and avoid New-Object during wrapper initialization.
- Test the fixed wrapper against external module paths, unknown cmdlets and injected arguments. Add a bounded, failure-only CI probe that reports engine/wrapper stages without dumping environment values or command payloads.
- The previous CI timeout could not be reproduced on local Windows 10 with Node.js 20.15.1 or 24.18.0. CI resolution remains unconfirmed until the updated workflow runs; the Linux npm configuration blocker is unchanged.

## 1.0.2 — 2026-09-29 (unreleased)

Patch release from 1.0.1: documentation and working-rule maintenance with no runtime behavior changes.

- Require a version bump and CHANGELOG entry for every delivered batch of changes, including AGENTS.md, README, validation records, comments and formatting. Documentation-only changes use PATCH.
- Remove the previous documentation-only version exemption and synchronize current version references. Existing Linux installation and Windows CI blockers are unchanged.

## 1.0.1 — 2026-09-22 (unreleased)

Patch release from 1.0.0: fixes CI timing and rollback test coverage without changing the MCP interface, command policies or production deadlines.

- Give successful PowerShell execution tests a consistent 15-second budget and report detailed results on failure; retain dedicated short-timeout tests and always shut down the executor.
- Inject verification failure only after real MCP/Audit verification in the deployed test SHA. Require activation evidence so earlier build failures cannot pass rollback tests.
- Test a genuinely changed loopback listener and Host, then verify configuration, token, release identity, working data and real MCP/Audit access after rollback on both platforms.
- Require startup evidence for health-failure tests and add injection boundary checks. Channel publication remains gated by all cross-platform checks and service tests.

## 1.0.0 — 2026-09-22 (unreleased)

Major release from the 0.5.0 implementation stage: allowlist mode no longer accepts arbitrary shell argument syntax. The existing MCP tools and result fields remain, but custom allowlists require explicit policies.

- Literal command parsing, exact argv matching, fixed native executables and a fixed PowerShell cmdlet wrapper replace shell interpretation in allowlist mode.
- COMMAND_BRIDGE_POLICY_FILE defines administrator-controlled schemaVersion 1 policies. Missing, duplicate, invalid or unsupported enabled policies fail before activation. Shells/script hosts cannot be custom safe targets.
- Resolve working directories through real paths to reject symlink/junction escapes and validate empty root entries before resolving.
- Includes the CI-verified installation channel and reliability improvements described under 0.5.0. No version tag is required by the new bootstrap.
- Migration: review [the 1.0 guide](docs/migration-1.0.md), create exact custom argument policies, protect policy permissions, and retain hostname for installation verification. Old complex arguments may now be rejected; unrestricted is never selected automatically.
- Validation: cross-platform unit/integration checks plus disposable service lifecycle CI gate channel publication. Local Windows testing does not substitute for an executed Linux/Windows service CI run.

## 0.5.0 — 2026-09-22 (unreleased implementation stage)

Minor release from 0.4.0: CI-verified bootstrap installation and reliability improvements, retaining the existing MCP interface.

- Fixed bootstrap URLs resolve a successful main commit through the serialized install channel. All source and installation assets come from one SHA; no release tag is required.
- Build-time application version comes from package.json. Installed identities include version, source SHA, and runtime version; uninstallers are saved with installations.
- Bounded process termination, cancellation and shutdown; audit helper deadlines; private rotating file audit for local stdio.
- Authenticated readiness and real service-account MCP/audit verification before upgrade backups are removed.
- Explicit network refresh preserves tokens and restores prior configuration on failure.

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
