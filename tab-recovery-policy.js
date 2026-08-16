const STALE_TAB_PATTERNS = [
  /no tab with id/i,
  /invalid tab id/i,
  /the tab was closed/i,
];

export function isStaleTabError(error) {
  const message = String(error?.message ?? error ?? "");
  return STALE_TAB_PATTERNS.some((pattern) => pattern.test(message));
}

export function isEmptyCaptureError(error) {
  return error?.code === "capture_empty";
}

export function shouldRetrySourceTab({
  error,
  acquisitionRound,
  attempt,
  ownership = null,
  emptyObservationRecovery = null,
}) {
  if (acquisitionRound !== 1 || attempt !== 0) return false;
  if (isStaleTabError(error)) return true;
  if (!isEmptyCaptureError(error) || ownership !== "managed") return false;
  if (emptyObservationRecovery === "reload_managed_once") return true;
  if (emptyObservationRecovery !== "reload_managed_once_if_unready") return false;
  return !isStableEmptyCapture(error?.details);
}

function isStableEmptyCapture(details = {}) {
  const readiness = String(details?.readinessState ?? "");
  if (readiness === "feed_empty") return true;
  return readiness === "feed_ready" &&
    Number(details?.selectorCandidateCount ?? 0) > 0 &&
    Number(details?.visibleSelectorCandidateCount ?? 0) > 0 &&
    Number(details?.observedBlockCount ?? 0) > 0;
}
