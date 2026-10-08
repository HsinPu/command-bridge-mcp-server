import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("Linux uninstall preflight preserves the old service on unsafe layouts or fallback failures", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync("bash", ["scripts/linux-systemd/tests/bootstrap-preflight.test.sh"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
});

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

test("Linux bootstrap replaces legacy uninstallers before mutation and trusts saved layout helpers", { skip: process.platform !== "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-uninstall-bootstrap-"));
  const bin = join(directory, "bin"), old = join(directory, "old"), app = join(directory, "app");
  const sha = "b".repeat(40);
  try {
    mkdirSync(bin); mkdirSync(join(directory, "source/scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(directory, "source/scripts/linux-systemd/uninstall.sh"), '#!/bin/bash\nset -eu\n# remove_all_program_roots\nprintf "fallback %s\\n" "$(cat "$(dirname "$0")/../../.command-bridge-source-sha")" >> "$FIXTURE/order"\nfor arg do case "$arg" in --dry-run|--help|-h) exit 0 ;; esac; done\nif [[ "${LEAVE_REMAINS:-0}" == 0 ]]; then rm -rf -- "$FIXTURE/old" "$FIXTURE/app.migration-backup"; fi\n');
    writeFileSync(join(directory, "source/scripts/linux-systemd/layout.sh"), "# saved helper\n");
    execFileSync("tar", ["-czf", join(directory, "archive.tar.gz"), "-C", directory, "source"]);
    writeFileSync(join(directory, "channel"), `${sha}\n5.0.1\n`);
    writeFileSync(join(bin, "curl"), '#!/bin/bash\nset -eu\nurl=; out=\nwhile (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\nprintf "%s\\n" "$url" >> "$FIXTURE/requests"\nif [[ "$url" == */channel.txt ]]; then [[ "${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"; else cp "$FIXTURE/archive.tar.gz" "$out"; fi\n');
    writeFileSync(join(bin, "stat"), '#!/bin/sh\n[ -e "$3" ] || [ -L "$3" ] || exec /usr/bin/stat "$@"\ncase "$2" in %u) if [ "$3" = "${UNSAFE_PATH:-}" ]; then echo 1234; else echo 0; fi;; %a) echo 755;; *) /usr/bin/stat "$@";; esac\n');
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
    assert.equal(readFileSync(join(directory, "order"), "utf8"), `fallback ${sha}\n`);
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
    assert.equal(readFileSync(join(directory, "order"), "utf8"), "");
    assert.equal(existsSync(join(old, "current/uninstall.sh")), true);
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

test("Linux uninstall uses one verified fallback for missing helpers and rejects unsafe saved assets", { skip: process.platform !== "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "cb-missing-helper-"));
  const bin = join(directory, "bin"), app = join(directory, "app"), old = join(directory, "old"), legacy = join(directory, "legacy");
  const roots = [app, old, legacy], sha = "c".repeat(40);
  const channel = join(directory, "channel"), order = join(directory, "order"), requests = join(directory, "requests");
  try {
    mkdirSync(bin); mkdirSync(join(directory, "source/scripts/linux-systemd"), { recursive: true });
    writeFileSync(join(directory, "source/scripts/linux-systemd/uninstall.sh"), `#!/bin/bash
set -eu
# remove_all_program_roots
source_root="$(dirname "$0")/../.."
printf 'fallback %s %s\\n' "$(cat "$source_root/.command-bridge-source-sha")" "$(cat "$source_root/.command-bridge-source-version")" >> "$FIXTURE/order"
printf '%s\\0' "$@" > "$FIXTURE/flags"
for arg do case "$arg" in --dry-run|--help|-h) exit 0 ;; esac; done
rm -rf -- "$FIXTURE/app" "$FIXTURE/old" "$FIXTURE/legacy"
`);
    writeFileSync(join(directory, "source/scripts/linux-systemd/layout.sh"), "# helper\n");
    execFileSync("tar", ["-czf", join(directory, "archive.tar.gz"), "-C", directory, "source"]);
    writeFileSync(join(bin, "curl"), `#!/bin/bash
set -eu
url=; out=
while (($#)); do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done
printf '%s\\n' "$url" >> "$FIXTURE/requests"
if [[ "$url" == */channel.txt ]]; then [[ "\${FAIL_CHANNEL:-0}" == 0 ]] || exit 22; cp "$FIXTURE/channel" "$out"
else [[ "\${FAIL_ARCHIVE:-0}" == 0 ]] || exit 22; cp "$FIXTURE/archive.tar.gz" "$out"; fi
`);
    // Model protected ownership, but never claim a missing file exists.
    writeFileSync(join(bin, "stat"), '#!/bin/sh\n[ -e "$3" ] || [ -L "$3" ] || exec /usr/bin/stat "$@"\ncase "$2" in %u) if [ "$3" = "${UNSAFE_PATH:-}" ]; then echo 1234; else echo 0; fi;; %a) if [ "$3" = "${WRITABLE_PATH:-}" ]; then echo 777; else echo 755; fi;; *) /usr/bin/stat "$@";; esac\n');
    chmodSync(join(bin, "curl"), 0o755); chmodSync(join(bin, "stat"), 0o755);
    const bootstrap = join(directory, "bootstrap.sh");
    writeFileSync(bootstrap, readFileSync("scripts/bootstrap.sh", "utf8")
      .replaceAll("/opt/command-bridge-mcp-server", legacy).replaceAll("/opt/command-bridge", old)
      .replaceAll("/usr/local/lib/command-bridge", app).replaceAll("/etc/systemd/system/", `${directory}/units/`)
      .replaceAll("/usr/local/libexec/", `${directory}/helpers/`).replaceAll("/etc/sudoers.d/", `${directory}/sudoers/`));
    mkdirSync(join(directory, "data")); writeFileSync(join(directory, "data/keep"), "preserved");
    const prepare = (root = app) => {
      for (const path of roots) rmSync(path, { recursive: true, force: true });
      mkdirSync(join(root, "current"), { recursive: true });
      writeFileSync(join(root, "current/uninstall.sh"), '#!/bin/bash\nset -eu\n# remove_all_program_roots\nsource "$(dirname "$0")/layout.sh"\necho saved >> "$FIXTURE/order"\n');
      writeFileSync(channel, `${sha}\n5.0.1\n`); writeFileSync(order, ""); writeFileSync(requests, "");
      rmSync(join(directory, "flags"), { force: true });
    };
    const run = (flags: string[] = [], extra = {}) => spawnSync("bash", [bootstrap, "--uninstall", "--yes", ...flags],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: directory, ...extra } });
    const assertSnapshot = () => {
      assert.equal(readFileSync(order, "utf8"), `fallback ${sha} 5.0.1\n`);
      assert.deepEqual(readFileSync(requests, "utf8").trim().split("\n"), [
        "https://raw.githubusercontent.com/HsinPu/command-bridge-mcp-server/install-channel/channel.txt",
        `https://github.com/HsinPu/command-bridge-mcp-server/archive/${sha}.tar.gz`
      ]);
    };
    for (const root of roots) {
      prepare(root);
      const result = run(["--purge"]); assert.equal(result.status, 0, result.stdout + result.stderr);
      assertSnapshot();
      assert.deepEqual(readFileSync(join(directory, "flags"), "utf8").split("\0"), ["--yes", "--purge", ""]);
      assert.equal(existsSync(root), false);
      assert.equal(readFileSync(join(directory, "data/keep"), "utf8"), "preserved");
    }
    for (const preview of ["--help", "-h", "--dry-run"]) {
      prepare(); const result = run([preview]); assert.equal(result.status, 0, result.stdout + result.stderr);
      assertSnapshot(); assert.equal(existsSync(join(app, "current/uninstall.sh")), true);
      assert.deepEqual(readFileSync(join(directory, "flags"), "utf8").split("\0"), ["--yes", preview, ""]);
    }
    for (const failure of [{ FAIL_CHANNEL: "1" }, { FAIL_ARCHIVE: "1" }]) {
      prepare(); assert.notEqual(run([], failure).status, 0);
      assert.equal(readFileSync(order, "utf8"), ""); assert.equal(existsSync(join(app, "current/uninstall.sh")), true);
    }
    prepare(); writeFileSync(channel, "main\n5.0.1\n"); assert.notEqual(run().status, 0);
    assert.equal(readFileSync(order, "utf8"), ""); assert.equal(readFileSync(requests, "utf8").trim().split("\n").length, 1);
    const helper = join(app, "current/layout.sh");
    for (const failure of ["owner", "writable", "directory", "dangling", "escape", "parent"] as const) {
      prepare(); let extra: Record<string, string> = {};
      if (failure === "directory") mkdirSync(helper);
      else if (failure === "dangling") symlinkSync(join(app, "current/absent"), helper);
      else if (failure === "escape") { writeFileSync(join(directory, "outside"), "# outside\n"); symlinkSync(join(directory, "outside"), helper); }
      else if (failure !== "parent") writeFileSync(helper, "# helper\n");
      if (failure === "owner") extra = { UNSAFE_PATH: helper };
      if (failure === "writable") extra = { WRITABLE_PATH: helper };
      if (failure === "parent") extra = { UNSAFE_PATH: join(app, "current") };
      for (const flags of [[], ["--help"]]) {
        assert.notEqual(run(flags, extra).status, 0, failure);
        assert.equal(readFileSync(requests, "utf8"), "", failure);
        assert.equal(readFileSync(order, "utf8"), "", failure);
        assert.equal(existsSync(join(app, "current/uninstall.sh")), true, failure);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
