import { loadConfig } from "./config/env.js";
try {
  loadConfig();
  console.log("Configuration and safe command policies are valid.");
} catch (error) {
  console.error("Configuration migration required:", error instanceof Error ? error.message : "Invalid configuration");
  process.exitCode = 1;
}
