(() => {
  if (globalThis.AkuBoundedCapturePolicy) return;

  const limits = Object.freeze({
    maxScrolls: 2,
    minScrollFraction: 0.5,
    maxScrollFraction: 0.9,
    maxScrollSettleMs: 2_000,
    maxCaptureTimeoutMs: 45_000,
    maxPendingContentTimeoutMs: 5_000,
    maxPendingContentSettleMs: 2_000,
    maxBlocksPerSnapshot: 20,
    maxBlockCharacters: 4_000,
  });

  function normalizeCapturePlan(payload = {}) {
    const acquisitionRound = clampInteger(payload.acquisitionRound, 1, 2, 1);
    const sameTabMutationAllowed =
      acquisitionRound === 1 &&
      payload.pendingContentPolicy === "reveal_if_present" &&
      payload.sameTabMutationAllowed === true;
    return Object.freeze({
      source: payload.source,
      scrolls: clampInteger(payload.scrolls, 0, limits.maxScrolls, 0),
      scrollFraction: clampNumber(
        payload.scrollFraction,
        limits.minScrollFraction,
        limits.maxScrollFraction,
        0.75,
      ),
      scrollSettleMs: clampInteger(
        payload.scrollSettleMs,
        100,
        limits.maxScrollSettleMs,
        900,
      ),
      captureTimeoutMs: clampInteger(
        payload.captureTimeoutMs,
        1_000,
        limits.maxCaptureTimeoutMs,
        limits.maxCaptureTimeoutMs,
      ),
      pendingContentPolicy:
        sameTabMutationAllowed ? "reveal_if_present" : "detect_only",
      sameTabMutationAllowed,
      pendingContentTimeoutMs: clampInteger(
        payload.pendingContentTimeoutMs,
        500,
        limits.maxPendingContentTimeoutMs,
        limits.maxPendingContentTimeoutMs,
      ),
      pendingContentSettleMs: clampInteger(
        payload.pendingContentSettleMs,
        100,
        limits.maxPendingContentSettleMs,
        700,
      ),
      maxBlocksPerSnapshot: clampInteger(
        payload.maxBlocksPerSnapshot,
        1,
        limits.maxBlocksPerSnapshot,
        limits.maxBlocksPerSnapshot,
      ),
      maxBlockCharacters: clampInteger(
        payload.maxBlockCharacters,
        40,
        limits.maxBlockCharacters,
        limits.maxBlockCharacters,
      ),
      acquisitionRound,
      continuation: acquisitionRound === 2 ? normalizeContinuation(payload.continuation) : null,
      restoreScroll: true,
    });
  }

  function countNewCandidates(blocks, seen) {
    let count = 0;
    for (const block of blocks) {
      const text = typeof block?.text === "string" ? block.text.replace(/\s+/g, " ").trim() : "";
      const key = block?.permalink || text.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
    return count;
  }

  function hasChangedVisibleFeed(beforeFingerprint, afterFingerprint) {
    return (
      typeof beforeFingerprint === "string" &&
      beforeFingerprint.length > 0 &&
      typeof afterFingerprint === "string" &&
      afterFingerprint.length > 0 &&
      beforeFingerprint !== afterFingerprint
    );
  }

  function platformIdFromCandidates(source, values) {
    for (const value of Array.isArray(values) ? values : []) {
      const candidate = typeof value === "string" ? value : "";
      if (!candidate) continue;
      if (source === "x") {
        const statusId = candidate.match(/\/status\/(\d+)/)?.[1];
        if (statusId) return `x:status:${statusId}`;
        continue;
      }
      const urn = candidate.match(/urn:li:(activity|ugcPost|share):(\d+)/i);
      if (urn) return `linkedin:${urn[1].toLowerCase()}:${urn[2]}`;
      const activity = candidate.match(/activity[-/:](\d+)/i);
      if (activity) return `linkedin:activity:${activity[1]}`;
    }
    return null;
  }

  function normalizeContinuation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const anchorKeys = Array.isArray(value.anchorKeys)
      ? value.anchorKeys
          .filter((key) => typeof key === "string")
          .map((key) => key.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (!Number.isFinite(value.startScrollY) || value.startScrollY < 0 || anchorKeys.length === 0) {
      return null;
    }
    return Object.freeze({
      startScrollY: Math.trunc(value.startScrollY),
      anchorKeys: Object.freeze(anchorKeys),
      settleMs: clampInteger(value.settleMs, 100, limits.maxScrollSettleMs, 900),
    });
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  }

  function clampNumber(value, minimum, maximum, fallback) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(minimum, Math.min(maximum, value))
      : fallback;
  }

  globalThis.AkuBoundedCapturePolicy = Object.freeze({
    limits,
    normalizeCapturePlan,
    countNewCandidates,
    hasChangedVisibleFeed,
    platformIdFromCandidates,
  });
})();
