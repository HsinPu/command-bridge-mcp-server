import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { AppError } from "../errors/AppError.js";

// A bounded preflight accident guard. External program/script internals remain opaque.
type Token = { value: string; operator: boolean };
export interface GuardedOptions { platform?: NodeJS.Platform; systemPaths?: string[] }

function block(code: string, rule: string): never {
  const error = new AppError(code, `Guarded mode rejected this operation (${rule}).`, "Use a separate administrator terminal for maintenance; this guard does not inspect arbitrary program internals.");
  error.rule = rule;
  throw error;
}
function unsupported(): never { return block("GUARDED_SYNTAX_UNSUPPORTED", "unsupported-shell-syntax"); }
const deletion = () => block("DELETE_OPERATION_BLOCKED", "file-deletion");
const system = (rule: string) => block("SYSTEM_MODIFICATION_BLOCKED", rule);

export function assertGuardedCommand(command: string, cwd: string, options: GuardedOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const roots = options.systemPaths ?? (platform === "win32" ?
    [process.env.SystemRoot ?? "C:\\Windows", process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"] :
    ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev"]);
  const lexical = (value: string) => {
    const result = path.resolve(cwd, value);
    return platform === "win32" ? result.toLowerCase() : result;
  };
  const canonical = (value: string) => {
    let cursor = path.resolve(cwd, value); const suffix: string[] = [];
    if (platform === process.platform) while (true) {
      try { cursor = realpathSync(cursor); break; }
      catch { const parent = path.dirname(cursor); if (parent === cursor) break; suffix.unshift(path.basename(cursor)); cursor = parent; }
    }
    return lexical(path.resolve(cursor, ...suffix));
  };
  const contains = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  };
  const targets = roots.flatMap(root => [lexical(root), canonical(root)]);
  const checkWrite = (value: string) => {
    if (!value || value.startsWith("-")) return;
    if (platform === "win32" && /^(?:HKLM|HKCU|HKCR|HKU|HKCC|Registry::)/i.test(value)) system("registry-write");
    const wildcard = value.search(/[?*\[]/);
    if (wildcard >= 0) { value = value.slice(0, wildcard); if (!value) value = "."; }
    if ([lexical(value), canonical(value)].some(candidate => targets.some(root => contains(root, candidate) || contains(candidate, root)))) system("protected-system-path");
  };
  const nameOf = (value: string) => value.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  const inspect = (tokens: Token[], depth: number) => {
    if (!tokens.length) return;
    let head = 0;
    // Only common wrappers with known options; unknown wrapper behavior stays outside the guarantee.
    while (head < tokens.length && /^(?:sudo|doas|command|exec|nohup|nice|env)$/.test(nameOf(tokens[head]!.value))) {
      const wrapper = nameOf(tokens[head++]!.value);
      while (tokens[head]?.value.startsWith("-")) {
        const option = tokens[head++]!.value;
        if (["-u", "-g", "--user", "--group", "-C", "-D"].includes(option) || (option === "-n" && wrapper === "nice")) head++;
      }
      if (wrapper === "env") while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[head]?.value ?? "")) head++;
    }
    if (!tokens[head]) unsupported();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[head]!.value)) unsupported();
    const name = nameOf(tokens[head]!.value), args = tokens.slice(head + 1).map(t => t.value), lower = args.map(a => a.toLowerCase());
    if (/^(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item|ri)$/.test(name)) deletion();
    if (name === "find" && lower.includes("-delete")) deletion();
    if (name === "rsync" && lower.some(a => /^--delete(?:-|=|$)|^--remove-source-files$/.test(a))) deletion();
    if (name === "robocopy" && lower.some(a => /^\/(?:mir|purge|mov|move)$/.test(a))) deletion();
    if (/^(?:apt|apt-get|dnf|yum|zypper|pacman|rpm|dpkg|winget|choco|scoop|msiexec)$/.test(name)) {
      const queries: Record<string, string[]> = { apt: ["list", "show", "search", "policy"], "apt-get": ["--version", "-v", "--help"], dnf: ["list", "info", "search", "repolist", "history"], yum: ["list", "info", "search", "repolist"], zypper: ["search", "info", "repos", "packages"], winget: ["list", "show", "search", "--version"], choco: ["list", "info", "search", "--version"], scoop: ["list", "info", "search", "status"] };
      const verb = lower.find(a => !a.startsWith("-")) ?? lower[0];
      const query = name === "rpm" ? lower.some(a => /^-q[a-z]*$|^--query$/.test(a)) && !args.some(a => /^-(?:i|e|U)|^--(?:install|erase|upgrade)/.test(a)) :
        name === "dpkg" ? lower.some(a => /^(?:-l|-s|-L|--list|--status|--listfiles)$/i.test(a)) && !lower.some(a => /^(?:-i|-r|-p|--install|--remove|--purge)$/i.test(a)) :
        name === "pacman" ? lower.some(a => /^-q[a-z]*$/i.test(a)) && !lower.some(a => /^-[sru]/i.test(a)) : (queries[name] ?? []).includes(verb ?? "");
      if (!query) system("package-management");
      // dnf history undo/rollback and query commands followed by mutation verbs are not read-only.
      if (lower.some(a => /^(install|remove|erase|upgrade|update|reinstall|autoremove|undo|rollback|reset)$/.test(a))) system("package-management");
    }
    if (/^(?:useradd|userdel|usermod|groupadd|groupdel|groupmod|passwd|chpasswd|gpasswd|visudo|adduser|deluser|new-localuser|remove-localuser|set-localuser|enable-localuser|disable-localuser|add-localgroupmember|remove-localgroupmember|new-localgroup|remove-localgroup|set-localgroup)$/.test(name)) system("account-management");
    if (name === "net" && lower.some(a => ["user", "localgroup", "accounts", "start", "stop"].includes(a)) && (lower.length > 1 || ["start", "stop"].includes(lower[0]!))) system("account-or-service-change");
    if (name === "systemctl" && lower.some(a => /^(?:start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|mask|unmask|edit|set-property|link|revert|daemon-reload|daemon-reexec|preset|preset-all|kill|isolate|switch-root|poweroff|reboot|halt|suspend|hibernate)$/.test(a))) system("service-change");
    if (name === "service" && lower.some(a => /^(?:start|stop|restart|reload|force-reload)$/.test(a))) system("service-change");
    if (/^(?:start-service|stop-service|restart-service|suspend-service|resume-service|set-service|new-service|remove-service)$/.test(name) || (name === "sc" && lower.some(a => /^(?:start|stop|config|create|delete|failure|failureflag|sdset|privs|triggerinfo|qfailureflag-set)$/.test(a)))) system("service-change");
    if (/^(?:reboot|shutdown|poweroff|halt|init|telinit|mount|umount|swapon|swapoff|fdisk|sfdisk|parted|wipefs|mkfs(?:\..+)?|mkswap|diskpart|format|format-volume|initialize-disk|clear-disk|new-partition|remove-partition|resize-partition|restart-computer|stop-computer)$/.test(name)) system("disk-or-host-change");
    if (name === "sysctl" && (lower.some(a => a === "-w" || a === "--write" || a === "-p" || a === "--load" || a === "--system") || args.some(a => a.includes("=")))) system("kernel-settings");
    if ((name === "hostname" && args.length > 0 && !lower.every(a => /^(?:--help|--version|-f|-s|-d|-i|-a)$/.test(a))) || /^(?:hostnamectl|timedatectl|localectl)$/.test(name) && lower.some(a => a.startsWith("set-"))) system("host-settings");
    if (name === "route" && lower.some(a => /^(?:add|del|delete|change|flush)$/.test(a))) system("network-change");
    if ((name === "ip" && lower.some(a => /^(?:add|delete|del|replace|change|set|flush)$/.test(a))) || (name === "nmcli" && lower.some(a => /^(?:modify|add|delete|up|down|connect|disconnect|on|off|reload|load)$/.test(a))) || (name === "ifconfig" && lower.length > 1)) system("network-change");
    if (/^(?:iptables|ip6tables|nft|ufw|firewall-cmd|netsh)$/.test(name)) {
      const query = name === "firewall-cmd" ? lower.some(a => /^--(?:list|query|get|state|version)/.test(a)) && !lower.some(a => /^--(?:add|remove|set|reload|complete-reload|runtime-to-permanent|panic|new|delete|load|reset)/.test(a)) :
        name === "ufw" ? lower[0] === "status" : name === "nft" ? lower[0] === "list" : name === "netsh" ? lower.includes("show") && !lower.some(a => /^(?:set|add|delete|reset|import|exec)$/.test(a)) :
        lower.some(a => ["-l", "-s", "--list", "--list-rules"].includes(a)) && !lower.some(a => /^--(?:append|delete|insert|replace|flush|policy)|^-[adirfpx]$/i.test(a));
      if (!query) system("firewall-change");
    }
    if (/^(?:set-netipaddress|new-netipaddress|remove-netipaddress|set-netipinterface|new-netroute|remove-netroute|set-netroute|set-dnsclientserveraddress|new-netfirewallrule|set-netfirewallrule|remove-netfirewallrule|enable-netfirewallrule|disable-netfirewallrule|register-scheduledtask|unregister-scheduledtask|set-scheduledtask|start-scheduledtask|stop-scheduledtask|enable-scheduledtask|disable-scheduledtask)$/.test(name)) system("network-or-task-change");
    if ((name === "reg" && !["query", "export", "compare"].includes(lower[0] ?? "")) || (name === "schtasks" && !lower.includes("/query")) || name === "crontab" && !lower.includes("-l")) system("registry-or-task-change");
    if (/^(?:curl|wget)$/.test(name)) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if ((name === "curl" && ["-o", "--output", "--output-dir"].includes(arg)) || (name === "wget" && ["-O", "--output-document", "-P", "--directory-prefix"].includes(arg))) checkWrite(args[++i] ?? "");
        else if (/^--(?:output|output-dir|output-document|directory-prefix)=/.test(arg)) checkWrite(arg.slice(arg.indexOf("=") + 1));
        else if (name === "curl" && arg.startsWith("-o") && arg.length > 2) checkWrite(arg.slice(2));
        else if (name === "wget" && /^-[OP].+/.test(arg)) checkWrite(arg.slice(2));
      }
    }
    if (name === "rsync" && args.length) checkWrite(args.at(-1)!);
    if (name === "robocopy" && args[1]) checkWrite(args[1]);
    const write = /^(?:mv|move|move-item|rename-item|ren|rename|cp|copy|copy-item|install|tee|touch|mkdir|md|new-item|truncate|chmod|chown|chgrp|ln|dd|patch|set-content|add-content|clear-content|out-file|set-item|clear-item|sc|ac|clc|si|cli|ni|sp|cpi|mi|set-itemproperty|new-itemproperty|remove-itemproperty|clear-itemproperty|set-acl|icacls|attrib)$/.test(name) || /^(?:sed|perl)$/.test(name) && args.some(a => /^--in-place(?:=|$)|^-[a-z]*i(?:\.|$)/i.test(a));
    if (write) {
      const cmdlet = /^(?:copy-item|move-item|rename-item|new-item|set-content|add-content|clear-content|out-file|set-item|clear-item|set-itemproperty|new-itemproperty|remove-itemproperty|clear-itemproperty|set-acl|cpi|mi|sc|ac|clc|si|cli|ni|sp)$/.test(name);
      if (cmdlet) {
        const named = new Map<string, string>(); const positional: string[] = [];
        const values = new Set(["path", "literalpath", "destination", "filepath", "newname", "value", "encoding", "type", "itemtype", "name", "filter", "include", "exclude", "credential", "erroraction", "warningaction", "informationaction", "width"]);
        const switches = new Set(["force", "recurse", "passthru", "append", "noclobber", "nonewline", "whatif", "confirm", "verbose", "debug"]);
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (!arg.startsWith("-")) { positional.push(arg); continue; }
          const parameter = arg.match(/^-([a-z]+)(?::(.*))?$/i);
          if (!parameter) unsupported();
          const key = parameter[1]!.toLowerCase();
          if (switches.has(key)) { if (parameter[2] !== undefined) unsupported(); continue; }
          if (!values.has(key) || named.has(key)) unsupported();
          const value = parameter[2] ?? args[++i];
          if (!value || value.startsWith("-")) unsupported();
          named.set(key, value);
        }
        if (named.has("path") && named.has("literalpath")) unsupported();
        const source = named.get("literalpath") ?? named.get("path") ?? named.get("filepath") ?? positional.shift();
        if (!source) unsupported();
        if (/^(?:copy-item|cpi|move-item|mi)$/.test(name)) {
          const destination = named.get("destination") ?? positional.shift() ?? ".";
          if (positional.length) unsupported();
          if (/^(?:move-item|mi)$/.test(name)) checkWrite(source);
          checkWrite(destination);
        } else {
          checkWrite(source);
          if (named.has("newname")) checkWrite(named.get("newname")!);
        }
      } else {
      const operands: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (/^(?:-e|-f|--expression|--file|-value|-encoding|-type|-m|--mode|-o|--owner|-g|--group)$/i.test(arg)) { i++; continue; }
        if (/^--(?:target-directory)=/.test(arg)) { checkWrite(arg.slice(arg.indexOf("=") + 1)); continue; }
        if (/^(?:-t|--target-directory)$/i.test(arg)) { checkWrite(args[++i] ?? ""); continue; }
        if (name === "dd") { if (/^of=/.test(arg)) checkWrite(arg.slice(3)); continue; }
        if (!arg.startsWith("-") && !(platform === "win32" && /^\/[a-z]$/i.test(arg))) operands.push(arg);
      }
      if (/^(?:cp|copy|copy-item|install|ln)$/.test(name)) { if (operands.length) checkWrite(operands[operands.length - 1]!); }
      else {
        if (/^(?:chmod|chown|chgrp)$/.test(name) && !args.some(a => a.startsWith("--reference"))) operands.shift();
        if (/^(?:sed|perl)$/.test(name) && !args.some(a => /^-e|^--expression|^-f|^--file/.test(a))) operands.shift();
        operands.forEach(checkWrite);
      }
      }
    }
    if (/^(?:bash|sh|dash|zsh|powershell|pwsh|cmd)$/.test(name)) {
      const index = args.findIndex(a => /^(?:-[a-z]*c|\/c|-command)$/i.test(a));
      if (index >= 0) { if (depth >= 3 || !args[index + 1]) unsupported();
        const tail = args.slice(index + 2).map(arg => {
          if (arg.includes('"')) unsupported();
          return '"' + (platform === "win32" ? arg : arg.replaceAll("\\", "\\\\")) + '"';
        });
        scan([args[index + 1]!, ...tail].join(" "), depth + 1); }
      if (lower.some(a => /^-(?:enc|encodedcommand)/.test(a))) unsupported();
    }
  };
  const scan = (text: string, depth: number) => {
    const tokens = tokenize(text, platform); let segment: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token.operator) { segment.push(token); continue; }
      if ([";", "&&", "||", "|", "\n"].includes(token.value)) { inspect(segment, depth); segment = []; }
      else if ([">", ">>"].includes(token.value)) {
        if (/^\d+$/.test(segment.at(-1)?.value ?? "")) segment.pop();
        if (tokens[i + 1]?.value === "&") { i++; if (!/^\d+$/.test(tokens[++i]?.value ?? "")) unsupported(); }
        else { const dest = tokens[++i]; if (!dest || dest.operator) unsupported(); checkWrite(dest.value); }
      } else if (token.value === "<") { const input = tokens[++i]; if (!input || input.operator) unsupported(); }
      else unsupported();
    }
    inspect(segment, depth);
  };
  scan(command, 0);
}

function tokenize(text: string, platform: NodeJS.Platform): Token[] {
  const tokens: Token[] = []; let word = "", quote = "", started = false;
  const flush = () => { if (started) tokens.push({ value: word, operator: false }); word = ""; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && platform !== "win32" && quote !== "'") { if (i + 1 === text.length) unsupported(); word += text[++i]; started = true; continue; }
    if (quote) {
      if (c === quote) quote = "";
      else { if (quote !== "'" && /[$`%]/.test(c)) unsupported(); word += c; }
      started = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/[$`%(){}\x00]/.test(c) || platform === "win32" && c === "^") unsupported();
    else if (c === "\n" || /[;|&<>]/.test(c)) { flush(); let value = c; if (text[i + 1] === c && /[|&<>]/.test(c)) { value += c; i++; } tokens.push({ value, operator: true }); }
    else if (/\s/.test(c)) flush();
    else { word += c; started = true; }
  }
  if (quote) unsupported(); flush(); return tokens;
}
