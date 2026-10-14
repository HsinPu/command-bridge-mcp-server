import os from "node:os";
import type { AppConfig } from "../config/env.js";

export function getSystemInfo(config: AppConfig) {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    uptimeSeconds: Math.trunc(os.uptime()),
    cpuCount: os.cpus().length,
    totalMemoryMb: toMegabytes(os.totalmem()),
    freeMemoryMb: toMegabytes(os.freemem()),
    executionMode: config.executionMode,
    backgroundJobs: { enabled: config.jobs?.enabled ?? false, defaultTimeoutMs: config.jobs?.defaultTimeoutMs ?? 1800000, maxTimeoutMs: config.jobs?.maxTimeoutMs ?? 3600000 },
    managedUpdate: { enabled: config.mcpUpdateEnabled !== false, serviceInstallationRequired: true },
    fileTransfer: { uploadEnabled: config.fileTransfer?.upload ?? false, downloadEnabled: config.fileTransfer?.download ?? false, maxBytes: config.fileTransfer?.maxBytes ?? 5242880, overwrite: false },
    allowedShells: config.allowedShells,
    allowedCommands: [...config.allowedCommands].sort(),
    allowedRoots: config.allowedRoots,
    maxParallelCommands: config.maxParallelCommands
  };
}

function toMegabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
