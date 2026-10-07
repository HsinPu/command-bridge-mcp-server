#!/usr/bin/env bash
# Prepare only the disposable test host; production path checks stay unchanged.
set -Eeuo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || { echo 'Disposable Linux test environment required.' >&2; exit 1; }
# Hosted runners make /opt writable. Both historical deployments and the new
# deployment must have protected parents before testing migration or rollback.
sudo chown root:root /opt /usr/local /usr/local/bin /usr/local/lib
sudo chmod 0755 /opt /usr/local /usr/local/bin /usr/local/lib
