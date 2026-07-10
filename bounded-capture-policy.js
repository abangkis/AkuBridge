(() => {
  if (globalThis.AkuBoundedCapturePolicy) return;

  const limits = Object.freeze({
    maxScrolls: 2,
    minScrollFraction: 0.5,
    maxScrollFraction: 0.9,
    maxScrollSettleMs: 2_000,
    maxCaptureTimeoutMs: 45_000,
    maxBlocksPerSnapshot: 20,
    maxBlockCharacters: 4_000,
  });

  function normalizeCapturePlan(payload = {}) {
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
  });
})();
