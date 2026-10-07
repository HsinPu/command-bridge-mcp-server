import { realpathSync } from "node:fs";
import { join, resolve, win32, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors/AppError.js";

// An accidental-command guard, not a shell interpreter or a filesystem sandbox.
const writes = /^(?:rm|rmdir|unlink|mv|cp|install|tee|touch|mkdir|truncate|chmod|chown|chgrp|ln|dd|patch|del|erase|rd|ren|rename|copy|move|icacls|attrib|set-content|add-content|clear-content|out-file|remove-item|copy-item|move-item|rename-item|new-item|set-item|clear-item|set-acl)$/i;
const wrappers = /^(?:sudo|doas|command|exec|nohup|nice|env)$/i;
const serviceNames = /^(?:command-bridge(?:-mcp-server)?(?:\.service)?|CommandBridgeMCP)$/i;
const serviceWrites = /^(?:edit|set-property|mask|unmask|enable|disable|link|revert|config|create|delete|set-service|new-service|remove-service)$/i;

export interface SelfProtectionOptions {
  platform?: NodeJS.Platform;
  protectedPaths?: string[];
  policyFile?: string;
}

export function protectedApplicationPaths(options: SelfProtectionOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (options.protectedPaths) return options.protectedPaths;
  const app = fileURLToPath(new URL("../../", import.meta.url));
  const paths = [app];
  if (options.policyFile) paths.push(options.policyFile);
  const dotenv = process.env.DOTENV_CONFIG_PATH;
  if (dotenv && dotenv !== "/dev/null") paths.push(resolve(dotenv));
  if (platform === "linux") paths.push(
    "/usr/local/libexec/command-bridge-update", "/var/lib/command-bridge-update", "/etc/sudoers.d/command-bridge-update", "/etc/systemd/system/command-bridge-update.service",
    "/etc/command-bridge", "/opt/command-bridge", "/usr/local/libexec/command-bridge", "/usr/local/bin/command-bridge",
    "/etc/systemd/system/command-bridge.service", "/etc/sudoers.d/command-bridge-audit-reader",
    "/etc/command-bridge-mcp-server", "/opt/command-bridge-mcp-server",
    "/etc/systemd/system/command-bridge-mcp-server.service"
  );
  if (platform === "win32") {
    const data = join(process.env.ProgramData ?? "C:\\ProgramData", "CommandBridgeMCP");
    paths.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "CommandBridgeUpdate"), join(process.env.ProgramData ?? "C:\\ProgramData", "CommandBridgeUpdate"));
    paths.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "CommandBridgeMCP"),
      join(data, "command-bridge.env"), join(data, "policy.json"));
  }
  return paths;
}

export function assertNoSelfModification(command: string, cwd: string, options: SelfProtectionOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const roots = protectedApplicationPaths(options);
  const canonical = (path: string) => {
    let cursor = paths.resolve(cwd, path), suffix: string[] = [];
    // Resolve the nearest existing ancestor, including links to not-yet-created files.
    if (platform === process.platform) {
      while (true) {
        try { cursor = realpathSync(cursor); break; }
        catch { const parent = paths.dirname(cursor); if (parent === cursor) break; suffix.unshift(paths.basename(cursor)); cursor = parent; }
      }
    }
    const result = paths.resolve(cursor, ...suffix);
    return platform === "win32" ? result.toLowerCase() : result;
  };
  const protectedRoots = roots.flatMap(root => [canonical(root), platform === "win32" ? paths.resolve(root).toLowerCase() : paths.resolve(root)]);
  const overlaps = (target: string) => {
    const candidates = [canonical(target), platform === "win32" ? paths.resolve(cwd, target).toLowerCase() : paths.resolve(cwd, target)];
    return candidates.some(candidate => protectedRoots.some(root => contains(root, candidate, paths) || contains(candidate, root, paths)));
  };
  const reject = () => { throw new AppError("SELF_MODIFICATION_BLOCKED", "This command appears to modify CommandBridge's own configuration, policy, program or service files.", "Manage CommandBridge from a separate administrator terminal; this preflight guard does not inspect indirect script behavior."); };
  const checkPath = (word: string) => {
    // Expand neither variables nor substitutions: their effects cannot be inferred safely.
    if (!word || /[$%`\x00]/.test(word) || word.startsWith("-")) return;
    let candidate = word;
    const assignment = candidate.match(/^(?:if|of|file|path|literalpath)=(.*)$/i);
    if (assignment) candidate = assignment[1]!;
    // A literal wildcard prefix may cover a protected directory or an ancestor.
    const wildcard = candidate.search(/[?*\[]/);
    if (wildcard >= 0) candidate = candidate.slice(0, wildcard);
    if (candidate && overlaps(candidate)) reject();
  };
  const scan = (text: string, depth: number) => {
    if (depth > 3) return;
    const tokens = tokenize(text, platform);
    let segment: string[] = [];
    const inspect = () => {
      if (!segment.length) return;
      let head = 0;
      while (head < segment.length) {
        const name = paths.basename(segment[head]!).replace(/\.exe$/i, "");
        if (!wrappers.test(name) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[head]!)) break;
        const wrapper = name.toLowerCase(); head++;
        while (segment[head]?.startsWith("-")) {
          const option = segment[head++]!;
          if (["-u", "-g", "--user", "--group", "-C", "-D", "-n"].includes(option) && (option !== "-n" || wrapper === "nice")) head++;
        }
      }
      const name = paths.basename(segment[head] ?? "").replace(/\.exe$/i, "");
      const args = segment.slice(head + 1);
      if (name.toLowerCase() === "request" && overlaps(segment[head] ?? "")) reject();
      if (/^(?:powershell|pwsh|bash|sh)$/i.test(name) && args.some(arg => /(?:^|[/\\])(?:request\.ps1|worker\.ps1|update-request)$/i.test(arg) && overlaps(arg))) reject();
      if (/^systemctl$/i.test(name) && args.some(arg => /^command-bridge-update(?:\.service)?$/i.test(arg)) && args.some(arg => /^(?:start|restart|stop|edit|disable|enable|mask|unmask)$/i.test(arg))) reject();
      if (/^schtasks$/i.test(name) && args.some(arg => /^(?:\/tn:)?\\?CommandBridgeUpdate$/i.test(arg)) && args.some(arg => /^\/(?:run|end|change|delete|create)$/i.test(arg))) reject();
      if (/^(?:start|stop|set|register|unregister|enable|disable)-scheduledtask$/i.test(name) && args.some(arg => /^(?:-taskname:)?\\?CommandBridgeUpdate$/i.test(arg))) reject();
      if (/^command-bridge(?:-mcp-server)?(?:\.cmd)?$/i.test(name) && args[0]?.toLowerCase() === "update" &&
          !(args.length === 2 && args[1]?.toLowerCase() === "--check")) reject();
      if (/^(?:bash|sh|powershell|pwsh)$/i.test(name) && args.some(arg =>
          /(?:^|[/\\])(?:bootstrap\.sh|bootstrap\.ps1|update\.ps1)$/i.test(arg) && overlaps(arg)) &&
          args.some(arg => /^(?:--update|-update)$/i.test(arg)) && !args.some(arg => /^(?:--check|-check)$/i.test(arg))) reject();
      if (/^(?:powershell|pwsh)$/i.test(name) && args.some(arg => /(?:^|[/\\])update\.ps1$/i.test(arg) && overlaps(arg)) &&
          !args.some(arg => /^-check$/i.test(arg))) reject();
      if (writes.test(name) || (/^(sed|perl)$/i.test(name) && args.some(arg => /^--in-place(?:=|$)|^-[a-z]*i(?:\.|$)/i.test(arg)))) {
        const operands: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (/^(?:-e|--expression|-f|--file)$/i.test(args[i]!) && /^(sed|perl)$/i.test(name)) { i++; continue; }
          if (/^(?:-m|--mode|-o|--owner|-g|--group|-value|-encoding|-type)$/i.test(args[i]!)) { i++; continue; }
          if (!args[i]!.startsWith("-")) operands.push(args[i]!);
        }
        if (/^(chmod|chown|chgrp)$/i.test(name) && !args.some(arg => arg.startsWith("--reference"))) operands.shift();
        if (/^(sed|perl)$/i.test(name) && !args.some(arg => /^-e|^--expression|^-f|^--file/.test(arg))) operands.shift();
        operands.forEach(checkPath);
      }
      if (/^(systemctl|sc|set-service|new-service|remove-service)$/i.test(name) &&
          (serviceWrites.test(name) || args.some(arg => serviceWrites.test(arg))) && args.some(arg => serviceNames.test(arg))) reject();
      if (/^(?:bash|sh|dash|zsh|powershell|pwsh|cmd)$/i.test(name)) {
        const index = args.findIndex(arg => /^(?:-[a-z]*c|\/c|-command)$/i.test(arg));
        if (index >= 0 && args[index + 1]) scan(args[index + 1]!, depth + 1);
      }
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if ([";", "|", "&", "\n"].includes(token)) { inspect(); segment = []; }
      else if (token === ">" || token === ">>") {
        if (/^\d+$/.test(segment[segment.length - 1] ?? "")) segment.pop();
        // >& duplicates a descriptor; it does not name an output file.
        if (tokens[i + 1] !== "&") checkPath(tokens[++i] ?? "");
      } else if (token !== "<" && token !== "<<") segment.push(token);
    }
    inspect();
  };
  scan(command, 0);
}

function contains(root: string, target: string, paths: typeof posix): boolean {
  const suffix = paths.relative(root, target);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + paths.sep) && !paths.isAbsolute(suffix));
}

function tokenize(text: string, platform: NodeJS.Platform): string[] {
  const result: string[] = []; let word = "", quote = "", started = false;
  const flush = () => { if (started) result.push(word); word = ""; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && platform !== "win32" && quote !== "'" && i + 1 < text.length) { word += text[++i]; started = true; continue; }
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\n" || /[;|&<>]/.test(c)) { flush(); if ((c === ">" || c === "<") && text[i + 1] === c) { result.push(c + c); i++; } else result.push(c); }
    else if (/\s/.test(c)) flush();
    else { word += c; started = true; }
  }
  flush(); return result;
}
