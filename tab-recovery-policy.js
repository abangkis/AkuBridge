const STALE_TAB_PATTERNS = [
  /no tab with id/i,
  /invalid tab id/i,
  /the tab was closed/i,
];

export function isStaleTabError(error) {
  const message = String(error?.message ?? error ?? "");
  return STALE_TAB_PATTERNS.some((pattern) => pattern.test(message));
}

export function shouldRetrySourceTab({ error, acquisitionRound, attempt }) {
  return acquisitionRound === 1 && attempt === 0 && isStaleTabError(error);
}
