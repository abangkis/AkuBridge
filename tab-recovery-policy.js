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
  return isEmptyCaptureError(error) &&
    ownership === "managed" &&
    emptyObservationRecovery === "reload_managed_once";
}
