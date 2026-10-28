export function isVerifiedSurfaceCleanupReceipt(outcome, leaseId, source = null) {
  const cleanup = outcome?.cleanup;
  if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup)) return false;
  if (cleanup.schema !== "aku.surface-cleanup.v1") return false;
  if (cleanup.leaseId !== leaseId || cleanup.source !== source) return false;
  const counts = [cleanup.expected, cleanup.closed, cleanup.transferred, cleanup.retained, cleanup.pending];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 4096)) return false;
  if (cleanup.expected !== cleanup.closed + cleanup.transferred + cleanup.retained + cleanup.pending) return false;
  if (cleanup.complete !== true || cleanup.pending !== 0) return false;
  const allowedReasons = ["", "no_owned_surface", "no_owned_source_surface", "surface_already_closed"];
  if (outcome.reason !== undefined && !allowedReasons.includes(outcome.reason)) return false;
  if (outcome.reason === "no_owned_source_surface" && source === null) return false;
  if (source === null && cleanup.retained !== 0) return false;
  if (outcome.reason === "no_owned_surface" && cleanup.retained !== 0) return false;
  return true;
}
