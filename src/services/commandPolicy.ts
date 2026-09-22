import { basename, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { AppError } from "../errors/AppError.js";
import { loadCommandProfiles, type CommandProfile } from "./commandProfiles.js";

export type ExecutionMode = "allowlist" | "unrestricted";
export type ShellKind = "bash" | "sh" | "powershell" | "cmd";

export interface CommandPolicyConfig {
  commandProfiles?: Map<string, CommandProfile>;
  executionMode: ExecutionMode;
  allowedShells: ShellKind[];
  allowedCommands: Set<string>;
  allowedRoots: string[];
}

export function parseLiteralCommand(command: string): string[] {
  if (/[\x00-\x1f\x7f;&|<>`$%(){}*?!~]/.test(command)) throw new AppError("SHELL_SYNTAX_BLOCKED", "Shell control syntax and expansion are disabled in allowlist mode.");
  const tokens: string[] = [];
  let current = "", quote = "", started = false;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === '"' || character === "'") {
      if (started) throw new AppError("SHELL_SYNTAX_BLOCKED", "Quotes must enclose an entire literal argument.");
      quote = character; started = true;
    } else if (character === " ") {
      if (started) { tokens.push(current); current = ""; started = false; }
    } else {
      current += character; started = true;
    }
  }
  if (quote) throw new AppError("SHELL_SYNTAX_BLOCKED", "Unclosed argument quote.");
  if (started) tokens.push(current);
  if (!tokens.length || !/^[a-z][a-z0-9_.-]*$/i.test(tokens[0]!)) throw new AppError("COMMAND_NOT_ALLOWED", "Command is not in the configured allowlist.");
  return tokens;
}

export function resolveSafeCommand(config: CommandPolicyConfig, shell: ShellKind, command: string): { profile: CommandProfile; args: string[] } {
  if (!config.allowedShells.includes(shell)) throw new AppError("SHELL_NOT_ALLOWED", "The requested shell is not enabled.");
  const [input, ...args] = parseLiteralCommand(command);
  const name = input!.toLowerCase();
  if (!config.allowedCommands.has(name)) throw new AppError("COMMAND_NOT_ALLOWED", "Command is not in the configured allowlist.");
  const profile = (config.commandProfiles ?? loadCommandProfiles()).get(name);
  if (!profile || !profile.shells.includes(shell)) throw new AppError("COMMAND_POLICY_MISSING", "No safe policy is available for this command and shell.");
  if (!profile.allowedArgs.some(allowed => allowed.length === args.length && allowed.every((arg, i) => arg === args[i]))) throw new AppError("COMMAND_ARGUMENTS_NOT_ALLOWED", "Arguments do not match an explicitly allowed argument combination.");
  return { profile, args };
}

export function assertCommandAllowed(
  config: CommandPolicyConfig,
  shell: ShellKind,
  command: string
): void {
  if (!config.allowedShells.includes(shell)) {
    throw new AppError(
      "SHELL_NOT_ALLOWED",
      "Shell '" + shell + "' is not enabled.",
      "Choose an allowed shell or update COMMAND_BRIDGE_ALLOWED_SHELLS."
    );
  }

  if (config.executionMode === "unrestricted") {
    return;
  }

  resolveSafeCommand(config, shell, command);
}

export function resolveWorkingDirectory(
  allowedRoots: string[],
  requestedDirectory?: string
): string {
  const requested = resolve(requestedDirectory ?? allowedRoots[0] ?? process.cwd());
  if (!allowedRoots.some(root => isWithinRoot(resolve(root), requested))) throw new AppError("WORKING_DIRECTORY_NOT_ALLOWED", "The requested working directory is outside the configured roots.");
  const directory = realpathSync(requested);
  const isAllowed = allowedRoots.some((root) => isWithinRoot(realpathSync(resolve(root)), directory));

  if (!isAllowed) {
    throw new AppError(
      "WORKING_DIRECTORY_NOT_ALLOWED",
      "The requested working directory is outside the configured roots.",
      "Choose a directory under COMMAND_BRIDGE_ALLOWED_ROOTS."
    );
  }

  return directory;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith("..\\") && !pathFromRoot.startsWith("../") && !isAbsolute(pathFromRoot));
}
