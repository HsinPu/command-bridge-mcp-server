# Architecture implementation validation

The working tree implements the installation/reliability stage described as 0.5.0 and the breaking policy stage described as 1.0.0. The current package is 1.0.0. Neither stage has been independently released by these changes, and the existing v0.4.0 tag is unchanged.

## Executed locally on Windows

- TypeScript build and Node test suite: 57 tests, 55 passed, two Linux-only tests skipped.
- Actual native command execution, PowerShell wrapper, HTTP authentication and Host rejection, MCP round trip, installer verification through a virtual Host, Audit failure, file rotation, cancellation, output limiting, helper timeout and termination-tool failure.
- Temporary Git repository verifies channel publication without tags, rejection of PR publication and prevention of an older commit replacing the channel.
- PowerShell parsing of all scripts, Bash syntax validation of every shell script and the fixed audit reader, and `git diff --check`.

## Pending disposable-environment validation

The GitHub workflow includes Windows/Linux service lifecycle jobs before channel publication. These jobs have not run for this working tree. They install actual services, check automatic startup configuration, reinstall, refresh networking, inject upgrade verification and service startup failures, check rollback and migration rejection, and exercise uninstall with preservation and purge.

Linux process-group termination and bootstrap snapshot/error behavior are tested by Linux-only tests and remain unexecuted locally. Actual machine reboot, native Audit backend failure injection, every fresh-install failure boundary and exhaustive permission/race scenarios are not fully covered by the current automated suite. Successful service restart and automatic-start configuration checks do not prove recovery after an actual reboot.

The fixed bootstrap must not be advertised as available until its files have been pushed and a successful main workflow has published `install-channel/channel.txt`. Missing or invalid channel data stops installation. No fallback to unverified main is provided.
