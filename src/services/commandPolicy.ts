import { basename, isAbsolute, relative, resolve } from "node:path";
import { AppError } from "../errors/AppError.js";

export type ExecutionMode = "allowlist" | "unrestricted";
export type ShellKind = "bash" | "sh" | "powershell" | "cmd";

export interface CommandPolicyConfig {
  executionMode: ExecutionMode;
  allowedShells: ShellKind[];
  allowedCommands: Set<string>;
  allowedRoots: string[];
}

const shellControlSyntax = /[\r\n;&|<>\x60]|\$\(|\$\{/;
const commandNamePattern = /^\s*([A-Za-z][A-Za-z0-9_.-]*)/;

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

  if (shellControlSyntax.test(command)) {
    throw new AppError(
      "SHELL_SYNTAX_BLOCKED",
      "Shell control syntax is disabled in allowlist mode.",
      "Run one simple allowlisted command, or explicitly enable unrestricted mode."
    );
  }

  const match = commandNamePattern.exec(command);
  const commandName = match?.[1]?.toLowerCase();

  if (!commandName || !config.allowedCommands.has(basename(commandName))) {
    throw new AppError(
      "COMMAND_NOT_ALLOWED",
      "Command is not in the configured allowlist.",
      "Use an allowed command or update COMMAND_BRIDGE_ALLOWED_COMMANDS."
    );
  }
}

export function resolveWorkingDirectory(
  allowedRoots: string[],
  requestedDirectory?: string
): string {
  const directory = resolve(requestedDirectory ?? allowedRoots[0] ?? process.cwd());
  const isAllowed = allowedRoots.some((root) => isWithinRoot(resolve(root), directory));

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
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}
