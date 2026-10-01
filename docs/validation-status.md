# Architecture implementation validation

The current package is 4.1.11, adding optional guarded execution with direct deletion/system modification checks while retaining existing sudo permissions, self-protection and service-account modes. Historical results below retain their tested versions. The existing v0.4.0 tag is unchanged. Installation availability is determined by the CI-published channel, independently of Git tags or this document's version number. A new commit is available through the public bootstrap only after its full cross-platform service gate succeeds.

## 4.1.11 validation

Preserve Windows source-mode file transfer after moving interop compilation into the build: predev prepares assets and both src/dist resolve the same fixed dist assembly. Local Windows npm test passed 80/92 with 12 skips, including unavailable elevation. npm run predev and a direct tsx source-mode lease probe passed, including rejection of directory replacement while locked. Version/lockfile consistency, document links, Bash fixture syntax and git diff --check passed. Hosted 4.1.10 general tests, including elevated native ACL behavior, have passed both platforms; its service gate is still running. Hosted 4.1.11 full verification/channel publication is pending this commit; Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.10 validation

Hosted 4.1.9 executed all production transfer ACL commands successfully; its regression then failed when inherited PowerShell 7 module paths prevented Windows PowerShell from auto-loading Get-Acl. The regression now reads ACLs directly through .NET, preserving all security assertions. Local Windows npm test passed 80/92 with 12 skips (including unavailable elevation). Direct Windows PowerShell .NET ACL reads and permission-enum checks passed. Modified PowerShell scripts, version-synchronized Bash fixtures, package versions and git diff --check passed. Hosted elevated ACL/general/service tests and channel publication are pending this commit; previous 4.1.7 hosted Linux service/migration succeeded. Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.9 validation

The hosted elevated 4.1.8 native ACL regression failed before service tests: removing inherited rights first denied later owner assignment. Production now preserves explicit SYSTEM/Administrators rights, assigns the owner, then removes inheritance and grants LocalService access. Local Windows npm test passed 80/92 with 12 skips, including the elevated-owner regression because this host is not elevated; modified PowerShell scripts and version-synchronized Bash fixtures passed syntax checks. Full local Linux tests were last run for 4.1.8 (82/92, ten skips); the 4.1.7 hosted Linux service/migration gate passed. Hosted 4.1.9 elevated ACL/general/service tests and channel publication are pending this commit; Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.8 validation

Hosted 4.1.7 Linux general/service/migration tests passed. The preceding Windows service run exposed icacls rejecting combined inheritance/owner options during transfer enablement. Those operations are now separate and an elevated disposable-directory regression invokes the production ACL function, checking Administrators ownership, protected inheritance and LocalService publication without directory deletion/control rights. Local Windows npm test passed 80/92 with 12 skips (11 platform skips plus the elevated-owner test); WSL with checksum-verified Node.js 24.18.0 passed 82/92 with ten platform skips. A non-elevated native CLI fixture with current-user ownership verified separate ACL commands, protected inheritance and non-deleting directory rights; it does not establish the Administrators-owner result. Bash/Audit reader and PowerShell syntax, versions, links and git diff --check passed. Hosted elevated ACL/full Windows service verification and channel publication are pending this commit; Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.7 validation

Hosted 4.1.6 Windows/Linux general tests passed, but Linux service lifecycle failed because the source checkout lacked the MCP SDK when invoking the file-transfer verifier. Both installers now deploy that verifier alongside the command verifier; service probes use the active installed release and its dependencies. Linux's deployment fixture checks the copied verifier contents. Final local Windows npm test passed 80/91 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 82/91 with nine skips. SELinux copy/rollback fixtures and Bash/PowerShell syntax, root versions, links and git diff --check passed. Hosted service tests and channel publication remain pending this commit; Oracle Linux Enforcing and actual reboot are unverified.

## 4.1.6 validation

Hosted 4.1.5 stage diagnostics confirmed both lease tests stalled during .NET compilation. Windows now builds the fixed native interop assembly once during npm run build and the runtime helper loads it from the application; the five-second readiness deadline and native directory handle protection are unchanged. Local Windows npm test passed 80/91 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 82/91 with nine skips. Native successful publication/replacement protection and failed-open/control-directory cleanup tests passed. Bash/Audit reader and PowerShell script syntax, package/lockfile versions, document links and git diff --check passed. Hosted CI/service validation and channel publication are pending this commit; Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.5 validation

The hosted 4.1.4 Windows run still failed the same directory-lease test despite sequential test files. The helper now supplies its compiler with explicit private TEMP/TMP and reports safe startup/compile/open stages without publishing compiler output. A new Windows behavior test verifies failed native opens and compiler-directory cleanup. Local Windows npm test passed 80/91 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 82/91 with nine skips. All Bash scripts/Audit reader and PowerShell scripts/WinSW XML, package/lockfile/build versions, document links and git diff --check passed. Hosted CI/service validation and installation-channel publication are pending this commit. Oracle Linux Enforcing and actual reboot remain unverified.

## 4.1.4 validation

The 4.1.3 hosted Windows run failed only the native directory-lease test while multiple test files launched cold PowerShell/compiler processes concurrently. Windows test files now run sequentially; production lock readiness remains five seconds and lease safety assertions remain intact. Local Windows npm test passed 79/90 with 11 platform skips; Ubuntu WSL using checksum-verified Node.js 24.18.0 passed 82/90 with eight skips. All Bash scripts/Audit reader and PowerShell scripts/WinSW XML passed syntax checks; package/lockfile versions, document links and git diff --check passed. Hosted CI, real installed services and channel publication are pending this commit; Oracle Linux Enforcing and actual reboot have not been reverified.

## 4.1.3 validation

Documentation-only patch recording the required Git commit after each completed, versioned and validated batch. Local Windows npm test passed 79/90 with 11 platform skips and no failures. The two version-synchronized Bash fixtures passed WSL syntax checks. Root package/lockfile and built server versions, relative document links, the four README bootstrap entries and git diff --check passed. This commit also includes the previously validated 4.1.2 guarded installation documentation. Full Linux tests, hosted CI/channel publication and real installed services have not been rerun for 4.1.3.

## 4.1.2 validation

Documentation/setup-preference patch: the primary README Windows/Linux commands now explicitly select guarded on fresh install and reinstall, preserving tokens and other settings. Runtime/bare-installer defaults are unchanged. Local Windows npm test passed 79/90 with 11 platform skips; the two version-synchronized Bash fixtures passed WSL syntax checks. Both README files retain exactly four one-line entries, with guarded added only to installation commands; bootstrap URLs and uninstall commands are unchanged. Root package/lockfile versions, built server version, relative document links and git diff --check passed. Full Linux tests, hosted CI/channel publication and real installed services have not been reverified for 4.1.2.

## 4.1.1 validation

Local Windows npm test passed 79/90 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 82/90 with eight platform skips. The four originally reproduced bypasses now return SYSTEM_MODIFICATION_BLOCKED: compact curl/wget output paths, Copy-Item destination-before-source and Set-Content colon-bound Path. Regression coverage includes protected versus ordinary output paths, case/quotes, named parameter order, LiteralPath/FilePath, system-source copies and explicit rejection of unsupported parameter abbreviations.

Executor regressions use nonexistent absolute executable paths so a missed guard cannot execute a real downloader or Cmdlet. They verify attempted/blocked events share their Audit ID, protected-write error codes, unchanged sentinel contents and continued normal execution. Existing real MCP/Audit integration tests passed. All Bash scripts/Audit reader and PowerShell scripts/WinSW XML passed syntax checks. Primary README commands remain unchanged; current version references, package/lockfile/build consistency, relative links and git diff --check were checked. Hosted CI/channel publication, real installed Windows/Linux service tests, Oracle Linux Enforcing and actual reboot are still unverified for this source. The guard remains bounded accident prevention.

## 4.1.0 validation

Local Windows npm test passed 78/89 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 81/89 with eight platform skips. Behavior tests cover deletion/synchronization options, sudo wrappers, system query versus modification, path case/links/ancestors, quoted text, unsupported syntax, nested Shell arguments, PowerShell write aliases, unchanged sentinel contents and concurrency recovery. Guarded errors expose the exact attempted Audit ID/rule. A real HTTP MCP round trip verifies guarded hostname execution and matching attempted/blocked lifecycle for a rejected deletion. SchemaVersion 1 Audit parsing retains guarded events; configuration defaults remain allowlist and file transfer stays independently disabled.

Linux fixture checks prove guarded mode selection, conflicting option rejection, other-setting preservation and full configuration rollback after an injected failure. Windows behavior checks prove explicit mode switching, unchanged other settings, preserved CRLF and retention of the original backup across subsequent edits. Initial failures from rewritten Bash fixture CRLF and a Windows CRLF assertion were corrected; final full runs are the results above. All Bash scripts/Audit reader, PowerShell scripts, WinSW XML and verifier JavaScript passed syntax checks. Version/build consistency, relative document links, unchanged primary README bootstrap commands and git diff --check passed.

Disposable Windows/Linux service smoke probes were extended to switch guarded on/off, preserve non-mode settings and verify actual MCP/Audit deletion/system-operation rejection; Linux also retains a real sudo-id probe. These hosted service probes, CI/channel publication, Oracle Linux Enforcing and actual reboot have not been run for this source. Neither local fixture success nor service enable/restart checks establish actual reboot behavior. Guarded is bounded accident prevention, not containment of arbitrary scripts/programs/root services; ordinary work-file overwrites remain possible.

## 4.0.0 validation

Local Windows npm test passed 71/82 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 74/82 with eight platform skips. Cross-platform behavior checks cover direct writes, read/other-sudo preservation, relative paths, links, case/quoted Windows paths, service edits and pre-spawn Audit. A real HTTP MCP round trip verifies SELF_MODIFICATION_BLOCKED, its attempted/blocked Audit lifecycle and unchanged file contents. The initially writable policy fixture failed readiness on both platforms; the corrected probe uses the actual protected application directory without relaxing readiness.

All PowerShell scripts, WinSW XML, the verifier JavaScript and all Bash scripts/Audit reader passed syntax checks. Package/lockfile versions, relative document links, unchanged README bootstrap entry commands and git diff --check passed. The new guard is accident prevention, not a complete sandbox. No privilege broker or systemd protection changes were made. The disposable Linux service smoke adds a protected sentinel rejection while retaining the real sudo-id verification, but hosted service smoke, CI/channel publication, Oracle Linux Enforcing and actual reboot are not yet verified for this source.

## 3.1.0 validation

New transfer tests exercise binary/SHA-256 round trips, exclusive publication, unsafe names, symlinks/hardlinks, malformed Base64, size limits, private root permissions, cancellation, Audit failures and concurrency-slot recovery. A real Linux HTTP MCP upload/download exceeds the former 100 KiB body limit; authentication precedes parsing and oversized bodies are rejected. Windows tests reject unverified ACLs and prove a native directory lease permits file publication while blocking directory rename, then releases it.

Local Windows npm test passed 66/77 with 11 platform skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 69/77 with eight platform skips. PowerShell/WinSW and all Bash scripts are checked individually. Real installed service transfer/Audit probes have been added to both disposable hosted smoke workflows but have not run for this source. Local Windows lock/ACL rejection tests do not prove successful LocalService deployment. Hosted CI, install-channel publication, Oracle Linux Enforcing and actual reboot remain unverified. This version intentionally supports flat filenames without overwrite.

## 3.0.0 validation

Linux install/reinstall now explicitly selects mode from installer options. Behavior checks cover inherited unrestricted settings ignored on fresh install, explicit opt-in, resetting an old unrestricted deployment, missing/noncanonical mode entries, token/custom roots preserved, and restoration of the complete old configuration after an injected failure. Local Windows `npm test` passed 62/69 with seven Linux-only skips. Ubuntu WSL, using temporary checksum-verified Node.js 24.18.0, passed 63/69 with six Windows-only skips. All Bash scripts and the Audit reader passed syntax checks; package/lockfile versions, README entry commands, relative file links and `git diff --check` passed. Disposable Linux service smoke now includes unrestricted-to-allowlist and explicit unrestricted restoration with unchanged non-mode settings and real MCP/Audit verification; that hosted service test has not run for this source. Hosted CI/channel, Oracle Linux Enforcing and actual reboot remain unverified for this version.

## 2.2.4 validation

Documentation-only patch selecting installer-account allowlist mode in both README fresh-install commands. Existing saved execution modes are preserved; migration instructions explicitly restore allowlist rather than promising a reinstall will do so. Local Windows `npm test` passed 62/69 with seven Linux-only skips. The two version-synchronized Bash fixtures passed Ubuntu WSL syntax checks. Both README Linux install commands were checked to contain `--run-as-installer --print-codex-setup` without `--unrestricted`; the four install/uninstall entries, relative file links, root package/lockfile versions and `git diff --check` passed. Windows commands, uninstall commands and fixed bootstrap URLs are unchanged. Full Linux tests, hosted CI and channel publication have not been verified for this version.

## 2.2.3 validation

Windows `npm test` passed 62/69 with seven Linux-only skips. Ubuntu WSL, using a temporary checksum-verified Node.js 24.18.0 runtime, passed 63/69 with six Windows-only skips. Behavior tests inject runtime/release copy failures, curl failure and installer failure, assert temporary files are removed and original exit codes preserved, and retain promoted runtime, old releases, unrelated staging paths and symlink targets. Configuration-restore failure does not prevent staging cleanup. All Bash scripts and the Audit reader passed syntax checks. Package/lockfile versions, the four README entry commands, relative file links and `git diff --check` passed. Windows install/uninstall commands and bootstrap URLs are unchanged. This patch does not sweep old deployments or guarantee cleanup after SIGKILL/power loss. Hosted service smoke, channel publication, Oracle Linux Enforcing and actual reboot checks have not run for this version.

## 2.2.2 validation

Documentation-only patch: both README Linux install commands explicitly select installer-account mode and unrestricted shell execution, with instructions for the dedicated-account and fresh allowlist alternatives. Installer defaults and runtime behavior are unchanged. Local Windows `npm test` passed 62/67 with five Linux-only skips after rerunning outside the sandbox that blocked Node subprocesses (`EPERM`). The modified Bash fixture passed Ubuntu WSL syntax checking. Both README files retain four one-line install/uninstall commands: only the Linux installation mode options changed; fixed bootstrap URLs, Windows and uninstall commands are unchanged. Relative file links, package/lockfile versions and `git diff --check` passed. A full Linux test run, hosted CI, publication, Oracle Linux Enforcing and real reboot tests have not been performed for this version.

## 2.2.1 validation

Account cleanup now has behavior tests for fresh installer mode, old managed identities, active processes, process-query errors, unexpected home/shell/UID/groups, deletion failure, pre-verification rejection and policy-group recreation. The disposable Linux service smoke covers a failed mode switch retaining the old identity, a successful switch removing it, a fresh installer-account installation without it, and reinstallation removing a simulated older leftover while retaining configuration and work data. Hosted CI must be verified for this source version before publication; Oracle Linux 8.10 Enforcing and actual reboot verification remain separate.

Local Windows `npm test` passed 62/67 with five Linux-only skips. Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 61/67 with six Windows-only skips. All Bash scripts passed individual syntax checks, and PowerShell scripts and WinSW XML parsed. Hosted service smoke and installation-channel publication require a successful run for the final commit; these local checks do not prove real host account removal.

## 2.2.0 validation

Local checks cover both installer setup blocks, name validation, token-variable separation and client-side collision instructions. Windows `npm test` passed 62/67 with five Linux-only skips. Ubuntu WSL `npm test` passed 61/67 with six Windows-only skips, using a temporary SHA-256-verified Node.js 24.18.0 runtime. All Bash scripts passed individual syntax checks; all PowerShell scripts and WinSW XML parsed; `git diff --check` passed. The first sandboxed Windows attempt could not spawn Node test subprocesses (`EPERM`), so the reported pass is from the unrestricted rerun. Hosted Windows/Linux general tests and disposable service smoke, channel publication, Oracle Linux 8.10 Enforcing installation, and an actual reboot remain separate checks until independently observed.

## 2.1.2 validation

The [2.1.1 CI run](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/36548647292) passed both general test jobs. Linux service smoke then started the injected installer-account candidate but failed to restore its prior release: the no-op Audit-reader rollback returned a failure status under `set -e`, so link/unit restoration never ran. A clean Ubuntu WSL reproduction confirmed the old configuration hash was restored while `current` still targeted the failed candidate. Version 2.1.2 corrects the no-op return status and adds a regression check.

Local 2.1.2 validation: Windows `npm test` passed 62/67 with five Linux-only skips. Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 61/67 with six Windows-only skips and all Bash syntax checks. A disposable Ubuntu WSL systemd installation started the injected candidate, observed its failure marker, then verified that the prior release link, configuration hash and service were restored and active. This does not establish Oracle Linux 8.10 Enforcing or actual reboot behavior. Hosted service smoke and install-channel publication still require a successful new run.

## 2.1.1 validation

The [2.1.0 CI run](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/36547940291) passed Ubuntu general tests but failed one Windows Audit invalid-payload test: its PowerShell child exceeded that test's five-second process limit (`ETIMEDOUT`). Service smoke and channel publication were correctly skipped. Version 2.1.1 raises only this test's launch budget to 15 seconds and adds elapsed-time diagnostics; the production Audit helper still has a five-second deadline. Cross-platform tests and service smoke for the new commit remain required before installation through the fixed bootstrap.

Local 2.1.1 validation: Windows `npm test` passed 62/67 with five Linux-only skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 61/67 with six Windows-only skips and all Bash syntax checks. These runs do not replace hosted Windows service or Oracle Linux 8.10 Enforcing validation.

## 2.1.0 validation

Local Windows `npm test` passed 62/67 tests with five Linux-only skips. Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 61/67 tests with six Windows-only skips; all Bash scripts passed syntax checks. The new installer-account behavior test passed account selection, explicit unrestricted opt-in, file Audit configuration, token/configuration preservation and Audit-reader rollback. The existing mocked SELinux repair/rollback test also passed. These local results do not establish a real installer-account service start or sudo execution.

The hosted service smoke now exercises a failed dedicated-to-installer-account switch, rollback to the original service with authenticated MCP/Audit, a successful installer-account service, a real MCP `sudo -n /usr/bin/id -u` call and matching file Audit, reinstall preservation, and purge without deleting the login account. Hosted Windows/Linux CI and channel publication have not yet run for this source version. Oracle Linux 8.10 Enforcing installation, sudo behavior under its PAM/SELinux policy, and an actual reboot remain unverified.

## 2.0.3 validation

The user's Oracle Linux 8.10 Enforcing retry built and tested 2.0.2 successfully, then stopped before activation while repairing the existing Node.js runtime: `restorecon: invalid option -- 'x'`. Its `restorecon` usage lists recursive `-R` but not `-x`. This is a distinct installer failure after the original `user_tmp_t`/`203/EXEC` issue; successful Ubuntu/Windows CI for 2.0.2 did not prove Oracle Linux compatibility.

Local validation: Windows `npm test` passed 61/65 with four Linux-only skips. Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 59/65 with six Windows-only skips, including the modified SELinux behavior test, and all Bash syntax checks passed. Eight PowerShell scripts and WinSW XML parsed; `git diff --check` passed. The fake `restorecon` rejects all options, including Oracle Linux 8's unsupported `-x`, and exercises reuse of an existing runtime, activation failure, and rollback. The local WSL environments do not run SELinux Enforcing. Hosted CI/channel publication, an Oracle Linux 8.10 Enforcing installation, and an actual reboot are separate pending checks at the time of this source change.

## 2.0.2 validation

The user supplied Oracle Linux 8.10 Enforcing evidence: Node.js retained `user_tmp_t`, systemd `init_t` was denied execute, and the service exited with `203/EXEC`. File mode permitted execution and the mount did not have `noexec`. This is the observed failure, not evidence that the corrected installer has passed on that host.

Local validation: Windows `npm test` passed 61/65 with four Linux-only skips; Ubuntu WSL with checksum-verified Node.js 24.18.0 passed 59/65 with six Windows-only skips. All eight Bash scripts plus the Audit reader passed syntax checks; eight PowerShell scripts and WinSW XML parsed. Package/lockfile versions and `git diff --check` passed. Hosted CI and channel publication must be checked against the final commit separately.

Behavior tests exercise new copies and runtime reuse, Disabled/Permissive/Enforcing detection, missing tools, label/verification failure before activation, symlink and work-data boundaries, and regular/1.x rollback ordering. These use mocked SELinux commands. The local Oracle Linux WSL is 9.4 with SELinux Disabled; its policy lookup maps the runtime Node path to `bin_t`, but it cannot validate enforcement. No Oracle Linux 8.10 Enforcing VM run or actual reboot has been performed. The opt-in `scripts/linux-systemd/tests/selinux-enforcing-smoke.sh` provides that separate lifecycle check. Hosted Ubuntu/Windows checks are also distinct from Enforcing validation.

## 2.0.1 validation

This patch changes documentation and the package version only; runtime behavior is the same as 2.0.0. Local Windows `npm test` passed 61 of 64 tests with three Linux-only skips. All six Bash scripts passed Ubuntu WSL syntax checks, all eight PowerShell scripts parsed, and `git diff --check` passed. These checks do not repeat the 2.0.0 service installation lifecycle, nor do they prove 2.0.1 hosted CI or channel publication.

## 2.0.0 validation

The Linux service and canonical paths changed. Local Ubuntu WSL testing passed the fresh installation lifecycle: enabled/active service, real MCP/Audit, reinstall, network refresh, injected verification and startup failures with rollback, default uninstall, reinstall and purge. A second disposable run installed the actual 1.0.5 source, forced a 2.0.0 post-activation verification failure, checked its deployed SHA marker and exact old configuration hash, confirmed the restored old service and MCP/Audit, then upgraded successfully to `command-bridge`. The saved token and work file were preserved, legacy paths became exact links, old Audit privileges were removed, and purge removed both layouts. These local source snapshots used synthetic SHAs; they are not channel publications or production-host validation. At the time of these local checks, the public bootstrap still served the last CI-approved SHA pending 2.0.0's cross-platform service jobs.

Local Windows validation passed 61 of 64 tests with three Linux-only skips. All seven Shell scripts and eight PowerShell scripts parsed, WinSW XML parsed, and `git diff --check` passed. Hosted Windows and Ubuntu service jobs remain the release gate; no actual host reboot is claimed.

## 1.0.5 validation history and release gate

[The 1.0.4 run](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/36521866541) passed both general test jobs. Linux failed during health-failure rollback after earlier real MCP/Audit checks passed; Windows failed its initial service health check. Both service jobs failed and channel publication was skipped. The current patch clears failed-candidate systemd start limits and adds bounded, category-only Windows startup diagnostics. Updated service CI and channel publication are required before claiming this version installable through the public bootstrap.

[The first 1.0.5 run](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/36524158857) passed both general test jobs and the complete Linux service lifecycle. Windows reported Running but failed its initial health probe, with no known startup error category; publication remained skipped. Follow-up work adds a direct, proxy-free Windows health probe with configured Host headers and a real HTTP regression test. The authoritative release gate remains successful jobs for both platforms plus publication of the matching full SHA/version in channel.txt; consult the CI run for the installed source SHA.

Later Windows diagnostics revealed repeated Node restarts and empty current logs; rotated logs must also be retained. Audit helpers now preserve only standard Windows startup directories and explicitly load trusted built-in modules while keeping the five-second deadline. Windows recovery tests wait for the restored listener before requiring authenticated readiness, real MCP hostname and matching Audit lifecycle. [The service-account validation run](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/36525934746) and [subsequent main runs](https://github.com/HsinPu/command-bridge-mcp-server/actions/workflows/ci.yml?query=branch%3Amain) provide the hosted results for each exact source SHA.

Local 1.0.5 validation: Node.js 20.15.1 on Windows, 64 tests, 61 passed and three Linux skips; all PowerShell scripts parsed, Bash scripts passed syntax checks, and git diff --check passed. Tests include real Windows HTTP probing with a virtual Host/unusable proxy, Audit helper startup with invalid payloads before Event Log writes, credential exclusion, diagnostic redaction/Audit filtering and output bounds. Hosted Linux service lifecycle passed in multiple follow-up runs. Local Windows service installation was not attempted because the current desktop process is not an administrator; CI uses the real LocalService account.

## Previous CI result

The subsequent [1.0.1 run 35695812805](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/35695812805) also passed Ubuntu but failed Get-Date on Windows: timedOut=true, durationMs=15074, empty stdout/stderr. Extending the test budget did not establish the cause or fix the issue.

[Run 35689995827](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/35689995827), for 1.0.0 commit 1c12406, passed Ubuntu tests but failed the Windows PowerShell success test. Service jobs and channel publication were skipped. This is not evidence that service lifecycle tests passed.

## Executed locally on Windows

### 1.0.4 compatibility check — 2026-09-29

- Node.js 20.15.1 full build/test suite: 62 tests, 59 passed, three Linux-only tests skipped. This includes executable Bash regression checks for Host validation and optional setup output. The initial sandbox attempt failed with spawn EPERM; the unrestricted local rerun passed.
- PowerShell scripts and WinSW XML parsed. This is not a Windows service lifecycle or hosted CI result.

### 1.0.3 investigation — 2026-09-29

- Downloaded and SHA-256 verified the same Node.js 24.18.0 Windows runtime used by CI. The pre-change Get-Date test and entire pre-change suite passed locally; the hosted Windows timeout was not reproduced on Windows 10. Module discovery or missing startup variables are hypotheses, not a confirmed diagnosis of the runner failure.
- Hardened startup by preserving standard Windows directory variables and explicitly loading trusted built-in module manifests. Added tests for filtered environment secrecy, external module search paths, and rejected commands/arguments. Added a failure-only CI diagnostic with engine/wrapper stage markers.
- Updated full suites passed on both Node.js 20.15.1 and 24.18.0: 61 tests, 59 passed, two Linux-only tests skipped. Actual Utility/Get-Date, Management/Get-Service and CIM/Get-CimInstance executions passed. The diagnostic reported engine-ready and wrapper-complete for both filtered and parent-reference environments (about 0.55 seconds each on this host). All PowerShell scripts parsed and git diff --check passed.
- No updated hosted-runner or Windows service lifecycle result is available yet. Do not claim the CI blocker is resolved until the new workflow passes.

### Historical 1.0.1 validation

- TypeScript build and Node test suite: 59 tests, 57 passed, two Linux-only tests skipped. This includes deployment-SHA injection boundaries, missing/wrong/stale evidence, changed-network enforcement, and startup evidence tests.
- A temporary source snapshot with the actual verification-failure injection passed the same full build/test suite (57 passed, two skipped), without creating activation evidence. This confirms the injected failure does not happen prematurely during source tests.
- Actual native command execution, PowerShell wrapper, HTTP authentication and Host rejection, MCP round trip, installer verification through a virtual Host, Audit failure, file rotation, cancellation, output limiting, helper timeout and termination-tool failure.
- Temporary Git repository verifies channel publication without tags, rejection of PR publication and prevention of an older commit replacing the channel.
- PowerShell parsing of all scripts, Bash syntax validation of every shell script and the fixed audit reader, and `git diff --check`.

## Ubuntu WSL validation (1.0.4) — 2026-09-29

- Tested the uncommitted 1.0.4 snapshot on Ubuntu 22.04, WSL 2, x86_64, with real systemd and checksum-verified Node.js 24.18.0. The temporary harness removed only the CI-only runner guard and retained diagnostic locations; it did not bypass installer validation. A synthetic SHA identified this local snapshot, not a published Git commit.
- Full build/test suites ran under the installer's temporary unprivileged build account: 62 tests, 58 passed, four Windows-only tests skipped. Audit reader regressions cover empty journals, filtering unrelated logs and preserving journal errors. Bash checks cover valid/invalid Host values and successful no-output setup.
- Real service lifecycle smoke test exited 0: fresh installation, enabled startup configuration, reinstall, network refresh, service restart, authenticated readiness, MCP hostname and matching attempted/completed Audit events.
- Verification-failure injection changed the listener/allowed Host to 127.0.0.1, completed real MCP/Audit verification, recorded the deployed test SHA, then failed intentionally. Health-failure injection separately recorded startup of its deployed SHA before exiting. Both restored the original release link, install-info hash, complete configuration (including token), working data and working MCP/Audit connection. Evidence for both stages was retained.
- Confirmed the service process has zero effective/ambient capabilities and permits the exact sudo Audit helper. Its capability ceiling and omitted incompatible systemd syscall restrictions are documented in the Linux guide.
- Invalid custom-policy migration was rejected. Default uninstall retained configuration and working data; subsequent reinstall and full purge succeeded. The harness cleanup also exited 0; a final check confirmed the service, application/configuration/data directories, Audit helper/sudo rule, service identity and temporary build identities were absent.
- All Bash scripts and the Audit reader passed syntax checks; systemd-analyze verify passed (the Windows-mounted checkout emitted permission warnings; the installer deploys the unit as root-owned 0644). PowerShell/XML checks and git diff --check passed locally.
- Diagnostic source, service log and the two activation evidence files are retained at `/var/tmp/command-bridge-linux-fix.LaYaLT` in Ubuntu. This validates local Linux service behavior, not hosted CI, ARM64, other distributions, actual reboot or the public bootstrap download path.

## Historical Ubuntu WSL validation (1.0.1) — 2026-09-29

- Tested committed 1.0.1 source (0bb38a0) in an isolated Linux source directory on Ubuntu 22.04, WSL 2, x86_64, glibc 2.35, with systemd running.
- Downloaded Node.js 24.18.0 and verified the official SHA-256 checksum. Built and ran tests as the unprivileged nobody account with Linux-only PATH and separate dependencies: 59 tests, 57 passed, two Windows-only tests skipped. Linux process-group termination and bootstrap snapshot/error tests passed.
- Attempted the real service lifecycle test using a temporary WSL harness adapted from the CI-only runner, after confirming no existing CommandBridge service, account, data or port conflict. Application and installer source were unchanged.
- Installation failed before service activation during npm ci: `double-loading config "/dev/null" as "global", previously loaded as "user"`. The installer assigns both npm_config_userconfig and npm_config_globalconfig to /dev/null in install and prune. They need distinct isolated configuration paths before service validation can continue.
- Cleanup completed successfully; verified absence of the service unit, application/configuration/state directories, audit helper/sudoers rule and dedicated service identity. No successful installation, rollback or native service Audit verification is claimed.
- Diagnostic source/runtime and logs are retained in Ubuntu at `/var/tmp/command-bridge-wsl-test.wP3VJZ`; the service log is `service-smoke.log` and test results are `tests.log`.

## Remaining validation

The GitHub workflow requires Windows/Linux service lifecycle jobs before channel publication. Verify the completed run for the full SHA in `install-channel/channel.txt`, rather than assuming that an earlier local result or a version badge validates a newer commit. Successful general tests alone are insufficient. No production skip-verification flag is introduced.

Actual machine reboot, native Audit backend failure injection, every fresh-install failure boundary and exhaustive permission/race scenarios are not fully covered by the current automated suite. Successful service restart and automatic-start configuration checks do not prove recovery after an actual reboot.

A new version must not be advertised as available through the fixed bootstrap until a successful main workflow publishes its exact SHA and version to `install-channel/channel.txt`. Missing or invalid channel data stops installation. No fallback to unverified main is provided.
