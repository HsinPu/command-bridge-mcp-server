import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("Linux bootstrap downloads one verified snapshot and fails closed on channel errors", { skip: process.platform !== "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "command-bridge-bootstrap-test-"));
  const bin = join(directory, "bin");
  const source = join(directory, "source");
  const sha = "a".repeat(40);
  try {
    mkdirSync(bin);
    mkdirSync(join(source, "scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(source, "scripts/linux-systemd/install.sh"), '#!/bin/bash\nset -eu\nroot="$(dirname "$0")/../.."\ncat "$root/.command-bridge-source-sha" "$root/.command-bridge-source-version" > "$FIXTURE/result"\n');
    execFileSync("tar", ["-czf", join(directory, "archive.tar.gz"), "-C", directory, "source"]);
    const mock = join(bin, "curl");
    writeFileSync(mock, '#!/bin/bash\nset -eu\nurl=\nout=\nwhile (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/requests"\nif [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"; else [[ "${FAIL_ARCHIVE:-0}" == 0 ]] || exit 22; cp "$FIXTURE/archive.tar.gz" "$out"; fi\n');
    chmodSync(mock, 0o755);
    const run = (extra = {}) => spawnSync("bash", [resolve("scripts/bootstrap.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: directory, ...extra } });
    writeFileSync(join(directory, "channel"), `${sha}\n1.0.0\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(directory, "result"), "utf8"), `${sha}\n1.0.0\n`);
    const requests = readFileSync(join(directory, "requests"), "utf8").trim().split("\n");
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.endsWith(`/archive/${sha}.tar.gz`));
    assert.notEqual(run({ FAIL_CHANNEL: "1" }).status, 0);
    assert.notEqual(run({ FAIL_ARCHIVE: "1" }).status, 0);
    writeFileSync(join(directory, "requests"), "");
    writeFileSync(join(directory, "channel"), "main\n1.0.0\n");
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(join(directory, "requests"), "utf8").trim().split("\n").length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Linux bootstrap completes old uninstallers with a pinned fallback and trusts saved layout helpers", { skip: process.platform !== "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-uninstall-bootstrap-"));
  const bin = join(directory, "bin"), old = join(directory, "old"), app = join(directory, "app");
  const sha = "b".repeat(40);
  try {
    mkdirSync(bin); mkdirSync(join(directory, "source/scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(directory, "source/scripts/linux-systemd/uninstall.sh"), '#!/bin/bash\nset -eu\nprintf "fallback %s\\n" "$(cat "$(dirname "$0")/../../.command-bridge-source-sha")" >> "$FIXTURE/order"\nif [[ "${LEAVE_REMAINS:-0}" == 0 ]]; then rm -rf -- "$FIXTURE/app.migration-backup"; fi\n');
    execFileSync("tar", ["-czf", join(directory, "archive.tar.gz"), "-C", directory, "source"]);
    writeFileSync(join(directory, "channel"), `${sha}\n4.6.0\n`);
    writeFileSync(join(bin, "curl"), '#!/bin/bash\nset -eu\nurl=; out=\nwhile (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/requests"\nif [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"; else cp "$FIXTURE/archive.tar.gz" "$out"; fi\n');
    writeFileSync(join(bin, "stat"), '#!/bin/sh\ncase "$2" in %u) if [ "$3" = "${UNSAFE_PATH:-}" ]; then echo 1234; else echo 0; fi;; %a) echo 755;; *) /usr/bin/stat "$@";; esac\n');
    chmodSync(join(bin, "curl"), 0o755); chmodSync(join(bin, "stat"), 0o755);
    // Redirect every managed host location, including privileged assets, to this fixture.
    const bootstrap = join(directory, "bootstrap.sh");
    writeFileSync(bootstrap, readFileSync("scripts/bootstrap.sh", "utf8")
      .replaceAll("/opt/command-bridge-mcp-server", join(directory, "legacy"))
      .replaceAll("/opt/command-bridge", old).replaceAll("/usr/local/lib/command-bridge", app)
      .replaceAll("/etc/systemd/system/", `${directory}/units/`)
      .replaceAll("/usr/local/libexec/", `${directory}/helpers/`)
      .replaceAll("/etc/sudoers.d/", `${directory}/sudoers/`));
    const run = (extra = {}, flags: string[] = []) => spawnSync("bash", [bootstrap, "--uninstall", "--yes", ...flags], { encoding: "utf8", timeout: 15_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: directory, ...extra } });
    const prepareOld = () => {
      mkdirSync(join(old, "current"), { recursive: true }); mkdirSync(`${app}.migration-backup`, { recursive: true });
      writeFileSync(join(old, "current/uninstall.sh"), '#!/bin/bash\nset -eu\nfor arg in "$@"; do [[ "$arg" != --help ]] || exit 0; done\necho old >> "$FIXTURE/order"\nrm -rf -- "$FIXTURE/old"\n');
      writeFileSync(join(directory, "order"), ""); writeFileSync(join(directory, "requests"), "");
    };
    prepareOld();
    const fallback = run(); assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
    assert.equal(readFileSync(join(directory, "order"), "utf8"), `old\nfallback ${sha}\n`);
    assert.match(readFileSync(join(directory, "requests"), "utf8"), new RegExp(`/archive/${sha}\\.tar\\.gz`));
    assert.equal(existsSync(`${app}.migration-backup`), false);
    prepareOld();
    const incomplete = run({ LEAVE_REMAINS: "1" });
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /Uninstallation is incomplete/);
    assert.equal(existsSync(`${app}.migration-backup`), true);
    prepareOld();
    assert.equal(run({ LEAVE_REMAINS: "1" }, ["--dry-run"]).status, 0);
    assert.equal(existsSync(`${app}.migration-backup`), true);
    prepareOld();
    assert.equal(run({}, ["--help"]).status, 0);
    assert.equal(readFileSync(join(directory, "requests"), "utf8"), "");
    assert.equal(existsSync(join(old, "current/uninstall.sh")), true);
    prepareOld();
    assert.notEqual(run({ FAIL_CHANNEL: "1" }).status, 0);
    assert.equal(readFileSync(join(directory, "order"), "utf8"), "old\n");
    rmSync(`${app}.migration-backup`, { recursive: true });
    mkdirSync(join(app, "current"), { recursive: true });
    writeFileSync(join(app, "current/uninstall.sh"), '#!/bin/bash\n# remove_all_program_roots\necho saved >> "$FIXTURE/order"\n');
    writeFileSync(join(app, "current/layout.sh"), "# saved helper\n");
    writeFileSync(join(directory, "order"), ""); writeFileSync(join(directory, "requests"), "");
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(directory, "order"), "utf8"), "saved\n");
    assert.equal(readFileSync(join(directory, "requests"), "utf8"), "");
    writeFileSync(join(directory, "order"), "");
    assert.notEqual(run({ UNSAFE_PATH: join(app, "current/layout.sh") }).status, 0);
    assert.equal(readFileSync(join(directory, "order"), "utf8"), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
