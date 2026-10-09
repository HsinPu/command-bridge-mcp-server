import { spawn } from "node:child_process";
import { join } from "node:path";
import { createOutputDecoder } from "../services/textEncoding.js";

export interface ServiceStatus {
  state: "running" | "stopped" | "starting" | "stopping" | "absent" | "unknown";
  autoStart: boolean | null;
  account: string | null;
  administrator: boolean;
  programTrusted?: boolean;
  configurationTrusted?: boolean | null;
  descriptionTrusted?: boolean | null;
}

export function unknownService(): ServiceStatus { return { state: "unknown", autoStart: null, account: null, administrator: process.geteuid?.() === 0 }; }

export function runServiceQuery(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 3000): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
    const decoder = createOutputDecoder("utf8");
    let output = "", bytes = 0, done = false;
    const finish = (result: string | null) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    const stop = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill(); } catch {}
      finish(null);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", (data: Buffer) => {
      if (done) return;
      bytes += data.length;
      if (bytes > 16384) { stop(); return; }
      try { output += decoder.decode(data, { stream: true }); } catch { stop(); }
    });
    child.once("error", () => finish(null));
    child.once("close", code => {
      if (done) return;
      try { finish(code === 0 ? output + decoder.decode() : null); } catch { finish(null); }
    });
  });
}

export function parseLinuxService(output: string): ServiceStatus {
  const fields = Object.fromEntries(output.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)));
  const states: Record<string, ServiceStatus["state"]> = { active: "running", inactive: "stopped", failed: "stopped", activating: "starting", deactivating: "stopping" };
  return {
    state: fields.LoadState === "not-found" ? "absent" : states[fields.ActiveState ?? ""] ?? "unknown",
    autoStart: fields.UnitFileState ? ["enabled", "enabled-runtime"].includes(fields.UnitFileState) : null,
    account: /^[A-Za-z0-9._@-]{1,128}$/.test(fields.User ?? "") ? fields.User! : null,
    administrator: process.geteuid?.() === 0
  };
}

export async function queryService(platform: NodeJS.Platform, release: string): Promise<ServiceStatus> {
  if (platform === "linux") {
    const result = await runServiceQuery("/usr/bin/systemctl", ["show", "command-bridge.service", "--property=LoadState,ActiveState,UnitFileState,User", "--no-pager"], { PATH: "/usr/bin:/bin", LANG: "C", SYSTEMD_COLORS: "0" });
    return result === null ? unknownService() : parseLinuxService(result);
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const result = await runServiceQuery(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(release, "scripts/windows/read-installation-status.ps1")], {
    SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PATH: join(systemRoot, "System32"), PSModulePath: join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules")
  });
  try {
    const value = JSON.parse(result ?? "");
    if (!value || Object.keys(value).sort().join(",") !== "account,administrator,autoStart,configurationTrusted,descriptionTrusted,programTrusted,state" ||
        !["running", "stopped", "starting", "stopping", "absent", "unknown"].includes(value.state) ||
        ![true, false, null].includes(value.autoStart) || typeof value.administrator !== "boolean" || typeof value.programTrusted !== "boolean" ||
        ![true, false, null].includes(value.configurationTrusted) || ![true, false, null].includes(value.descriptionTrusted) ||
        (value.account !== null && (typeof value.account !== "string" || value.account.length > 128 || /[\x00-\x1f\x7f]/.test(value.account)))) throw new Error();
    return value as ServiceStatus;
  } catch { return { ...unknownService(), administrator: false, programTrusted: false }; }
}
