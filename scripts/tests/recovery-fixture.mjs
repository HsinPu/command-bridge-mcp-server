// Mutate only the disposable CI snapshot; production has no skip/fault flags.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareRecoveryFault(root, sha, marker) {
  if (!/^[a-f0-9]{40}$/.test(sha) || existsSync(marker)) throw Error('Invalid or stale recovery fixture');
  writeFileSync(join(root, '.command-bridge-source-sha'), sha);
  const inject = (file, anchor, code) => {
    const path = join(root, file), text = readFileSync(path, 'utf8');
    if (!text.includes(anchor)) throw Error('Missing recovery fixture anchor');
    writeFileSync(path, text.replace(anchor, anchor + '\n' + code));
  };
  // Called only after real readiness/MCP/Audit/diagnostics/CLI and helper install.
  inject('scripts/linux-systemd/program-migration.sh', 'commit_application_layout() {', `  if [[ "\${SOURCE_REF:-}" == '${sha}' && "\${ACTIVATION_STARTED:-0}" == 1 ]]; then
    "\${RUNTIME_LINK}/bin/node" --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs";const [info,marker,sha]=process.argv.slice(1);if(JSON.parse(readFileSync(info)).sourceSha!==sha)throw Error("Wrong recovery deployment");writeFileSync(marker,JSON.stringify({stage:"verified",sha,fault:"INJECTED_RECOVERY_FAILURE"}),{flag:"wx"})' "\${CURRENT_LINK}/install-info.json" '${marker}' '${sha}'
    fail INJECTED_RECOVERY_FAILURE
  fi`);
  inject('scripts/linux-systemd/managed-update.sh', 'restore_managed_update_assets() {', `  if [[ "\${SOURCE_REF:-}" == '${sha}' && "\${ROLLBACK_IN_PROGRESS:-0}" == 1 ]]; then return 91; fi`);
}

export function assertRecoveryEvidence(marker, sha) {
  const evidence = JSON.parse(readFileSync(marker, 'utf8'));
  if (evidence.sha !== sha || evidence.stage !== 'verified' || evidence.fault !== 'INJECTED_RECOVERY_FAILURE') throw Error('Missing or incorrect recovery activation evidence');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'prepare') prepareRecoveryFault(...args);
  else if (action === 'assert') assertRecoveryEvidence(...args);
  else throw Error('Unknown recovery fixture command');
}
