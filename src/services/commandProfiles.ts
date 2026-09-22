import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ShellKind } from "./commandPolicy.js";

export interface CommandProfile {
  name: string;
  platform: "linux" | "win32";
  shells: ShellKind[];
  executable: string;
  allowedArgs: string[][];
  cmdlet?: string;
}
const schema = z.object({
  schemaVersion: z.literal(1),
  commands: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    platform: z.enum(["linux", "win32"]),
    shells: z.array(z.enum(["bash", "sh", "powershell", "cmd"])).min(1),
    executable: z.string().min(1),
    allowedArgs: z.array(z.array(z.string().refine(s => !/[\x00-\x1f\x7f]/.test(s), "Control characters are forbidden"))).min(1)
  }).strict())
}).strict();
const scriptHosts = /^(?:a|ba|da|z|k|c|tc|fi)?sh$|^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|node|nodejs|deno|bun|python\d*(?:\.\d+)*|perl|ruby|php|java|dotnet|lua\d*(?:\.\d+)*|tclsh|wish|expect|rscript|julia|busybox|env|awk|gawk|mawk)$/i;

export function assertNativeExecutable(path: string): string {
  if (!isAbsolute(path)) throw new Error("Policy executable must be an absolute path.");
  const actual = realpathSync(path);
  for (const name of [path, actual]) {
    if (/\.(?:ps1|cmd|bat|sh|py|js|vbs)$/i.test(name) || scriptHosts.test(basename(name).replace(/\.exe$/i, ""))) throw new Error("Shells and script hosts are forbidden in safe policies.");
  }
  if (!statSync(actual).isFile()) throw new Error("Policy executable must be a regular native executable.");
  const descriptor = openSync(actual, "r");
  const header = Buffer.alloc(4);
  try { readSync(descriptor, header, 0, 4, 0); } finally { closeSync(descriptor); }
  if (process.platform === "win32" ? header.toString("ascii", 0, 2) !== "MZ" : header.toString("hex") !== "7f454c46") throw new Error("Policy target is not a native executable for this platform.");
  return actual;
}

export function loadCommandProfiles(file?: string): Map<string, CommandProfile> {
  const profiles = new Map<string, CommandProfile>();
  if (process.platform === "win32") {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    for (const name of ["hostname", "whoami", "systeminfo", "tasklist"]) profiles.set(name, { name, platform: "win32", shells: ["powershell", "cmd"], executable: join(system, name + ".exe"), allowedArgs: [[]] });
    for (const [name, module] of [["Get-Date", "Microsoft.PowerShell.Utility"], ["Get-ComputerInfo", "Microsoft.PowerShell.Management"], ["Get-Process", "Microsoft.PowerShell.Management"], ["Get-Service", "Microsoft.PowerShell.Management"], ["Get-CimInstance", "CimCmdlets"]]) {
      profiles.set(name!.toLowerCase(), { name: name!.toLowerCase(), platform: "win32", shells: ["powershell"], executable: join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), cmdlet: `${module}\\${name}`, allowedArgs: name === "Get-CimInstance" ? [[], ["-ClassName", "Win32_OperatingSystem"]] : [[]] });
    }
  } else if (process.platform === "linux") {
    for (const name of ["uname", "hostname", "whoami", "uptime", "date", "df", "free", "ps", "pwd"]) {
      const executable = [join("/usr/bin", name), join("/bin", name)].find(existsSync) ?? join("/usr/bin", name);
      profiles.set(name, { name, platform: "linux", shells: ["bash", "sh", "powershell"], executable, allowedArgs: [[]] });
    }
  }
  if (file) {
    if (!isAbsolute(file)) throw new Error("COMMAND_BRIDGE_POLICY_FILE must be absolute.");
    const document = schema.parse(JSON.parse(readFileSync(file, "utf8")));
    const seen = new Set<string>();
    for (const item of document.commands) {
      if (seen.has(item.name) || profiles.has(item.name)) throw new Error(`Duplicate or reserved policy name: ${item.name}`);
      seen.add(item.name);
      if (item.platform !== process.platform) continue;
      const validShells = item.platform === "win32" ? ["powershell", "cmd"] : ["bash", "sh", "powershell"];
      if (item.shells.some(shell => !validShells.includes(shell))) throw new Error(`Policy has an unsupported platform shell: ${item.name}`);
      profiles.set(item.name, { ...item, executable: assertNativeExecutable(item.executable) });
    }
  }
  return profiles;
}

export function validateEnabledProfiles(profiles: Map<string, CommandProfile>, names: Set<string>, shells: ShellKind[]): void {
  for (const name of names) {
    const profile = profiles.get(name);
    if (!profile) throw new Error(`No safe policy for enabled command '${name}'. Define COMMAND_BRIDGE_POLICY_FILE before upgrading.`);
    if (!shells.some(shell => profile.shells.includes(shell))) throw new Error(`No enabled shell can execute policy '${name}'.`);
    if (profile.cmdlet) { if (!existsSync(profile.executable)) throw new Error("PowerShell is unavailable."); }
    else assertNativeExecutable(profile.executable);
  }
}
