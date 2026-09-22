# Architecture implementation validation

The current package is 1.0.1 (unreleased), a patch to the 1.0.0 CI timing and rollback tests. The existing v0.4.0 tag is unchanged.

## Previous CI result

[Run 35689995827](https://github.com/HsinPu/command-bridge-mcp-server/actions/runs/35689995827), for 1.0.0 commit 1c12406, passed Ubuntu tests but failed the Windows PowerShell success test. Service jobs and channel publication were skipped. This is not evidence that service lifecycle tests passed.

## Executed locally on Windows

- TypeScript build and Node test suite: 59 tests, 57 passed, two Linux-only tests skipped. This includes deployment-SHA injection boundaries, missing/wrong/stale evidence, changed-network enforcement, and startup evidence tests.
- A temporary source snapshot with the actual verification-failure injection passed the same full build/test suite (57 passed, two skipped), without creating activation evidence. This confirms the injected failure does not happen prematurely during source tests.
- Actual native command execution, PowerShell wrapper, HTTP authentication and Host rejection, MCP round trip, installer verification through a virtual Host, Audit failure, file rotation, cancellation, output limiting, helper timeout and termination-tool failure.
- Temporary Git repository verifies channel publication without tags, rejection of PR publication and prevention of an older commit replacing the channel.
- PowerShell parsing of all scripts, Bash syntax validation of every shell script and the fixed audit reader, and `git diff --check`.

## Pending disposable-environment validation

The GitHub workflow includes Windows/Linux service lifecycle jobs before channel publication. These jobs have not run for 1.0.1. They install actual services, check automatic startup configuration, reinstall, refresh networking to a different loopback address, inject failures only after deployment, require stage evidence, verify restored identity/configuration/data and real MCP/Audit access, and exercise migration rejection and uninstall with preservation and purge. No production skip-verification flag is introduced.

Linux process-group termination and bootstrap snapshot/error behavior are tested by Linux-only tests and remain unexecuted locally. Actual machine reboot, native Audit backend failure injection, every fresh-install failure boundary and exhaustive permission/race scenarios are not fully covered by the current automated suite. Successful service restart and automatic-start configuration checks do not prove recovery after an actual reboot.

The fixed bootstrap must not be advertised as available until its files have been pushed and a successful main workflow has published `install-channel/channel.txt`. Missing or invalid channel data stops installation. No fallback to unverified main is provided.
