const terminalRunStatuses = new Set(["completed", "partial", "failed", "cancelled"]);

export function sourceCaptureSurfaceReleasable(run) {
  // Native collectors retire their resources through their own batch owner.
  if (!runUsesBrowserCapture(run)) return false;
  if (!run || typeof run !== "object") return false;
  if (terminalRunStatuses.has(run.status)) return true;
  return run.status === "reasoning" && run.stage === "candidate_evaluation";
}

// Unknown/legacy runs remain conservative. This metadata never authorizes capture.
export function sessionUsesBrowserCapture(session) {
 return !Array.isArray(session?.runs) || session.runs.length === 0 ||
   session.runs.some(runUsesBrowserCapture);
}

export function runUsesBrowserCapture(run) {
 return !["headless", "browser_quiet_hidden"].includes(run?.captureCollector);
}
