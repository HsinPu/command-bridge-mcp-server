# Architecture implementation validation

The current package is 1.0.4 (unreleased), a Linux installer and native Audit startup patch. Historical results below retain their tested versions. The existing v0.4.0 tag is unchanged. Local validation does not publish the installation channel or resolve the untested hosted Windows CI result.

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

The GitHub workflow includes Windows/Linux service lifecycle jobs before channel publication. No hosted CI or channel publication is claimed for this unpushed 1.0.4 delivery. Linux service lifecycle checks passed locally as described above; Windows service lifecycle and the previously failing hosted Windows execution test remain pending. No production skip-verification flag is introduced.

Actual machine reboot, native Audit backend failure injection, every fresh-install failure boundary and exhaustive permission/race scenarios are not fully covered by the current automated suite. Successful service restart and automatic-start configuration checks do not prove recovery after an actual reboot.

The fixed bootstrap must not be advertised as available until its files have been pushed and a successful main workflow has published `install-channel/channel.txt`. Missing or invalid channel data stops installation. No fallback to unverified main is provided.
