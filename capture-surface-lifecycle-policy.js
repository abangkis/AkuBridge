const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);

export function sourceCaptureSurfaceReleasable(run) {
  if (!run || typeof run !== "object") return false;
  if (terminalRunStatuses.has(run.status)) return true;
  return run.status === "reasoning" && run.stage === "candidate_evaluation";
}
