/** Only an Audit failure may keep an authenticated, diagnostic-only server alive. */
export function permitsDiagnosticStartup(readiness: {ready:boolean;checks:Record<string,boolean>}):boolean {
  if (readiness.ready) return true;
  const {checks}=readiness;
  return checks.audit===false && checks.workingDirectory===true && checks.shells===true &&
    Object.entries(checks).every(([name,ok])=>ok || ["audit","accepting","verification"].includes(name));
}
