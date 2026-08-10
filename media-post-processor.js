(() => {
  const runtimeRevision = "media-post-processor-v2";
  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");

  const defaults = Object.freeze({
    maxCandidates: 128,
    maxMediaPerCandidate: 4,
    ttlMs: 15 * 60 * 1_000,
  });

  function createEvidenceRuntime(options = {}) {
    const source = boundedString(options.source, 40);
    const candidateIdFromContainer = options.candidateIdFromContainer;
    const normalizeCandidateId = options.normalizeCandidateId;
    const normalizeMedia = options.normalizeMedia;
    if (!source || typeof candidateIdFromContainer !== "function" ||
        typeof normalizeCandidateId !== "function" || typeof normalizeMedia !== "function") {
      throw new Error("AkuBridge media evidence runtime requires source-specific identity and media policies.");
    }

    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const maxCandidates = clampInteger(options.maxCandidates, 1, 512, defaults.maxCandidates);
    const maxMediaPerCandidate = clampInteger(
      options.maxMediaPerCandidate,
      1,
      8,
      defaults.maxMediaPerCandidate,
    );
    const ttlMs = clampInteger(options.ttlMs, 1_000, 60 * 60 * 1_000, defaults.ttlMs);
    const entries = new Map();
    const counters = { accepted: 0, rejected: 0, expired: 0, evicted: 0 };

    function ingestStructured(payload) {
      const candidates = Array.isArray(payload) ? payload : payload?.candidates;
      let acceptedCandidateCount = 0;
      for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 24) : []) {
        const candidateId = normalizeCandidateId(candidate?.candidateId);
        if (!candidateId || !Array.isArray(candidate?.media)) {
          counters.rejected += 1;
          continue;
        }
        const media = candidate.media
          .slice(0, maxMediaPerCandidate)
          .map((value) => normalizeMedia(value))
          .filter(Boolean);
        if (media.length === 0) {
          counters.rejected += 1;
          continue;
        }
        put(candidateId, media);
        acceptedCandidateCount += 1;
      }
      return acceptedCandidateCount;
    }

    function put(candidateId, media) {
      purgeExpired();
      entries.delete(candidateId);
      entries.set(candidateId, {
        expiresAtMs: now() + ttlMs,
        media: media.map((value) => Object.freeze({ ...value })),
      });
      counters.accepted += 1;
      while (entries.size > maxCandidates) {
        entries.delete(entries.keys().next().value);
        counters.evicted += 1;
      }
    }

    function lookup(candidateId) {
      const normalized = normalizeCandidateId(candidateId);
      if (!normalized) return [];
      purgeExpired();
      const entry = entries.get(normalized);
      if (!entry) return [];
      entries.delete(normalized);
      entries.set(normalized, entry);
      return entry.media.map((value) => Object.freeze({ ...value }));
    }

    function lookupContainer(container) {
      return lookup(candidateIdFromContainer(container));
    }

    function purgeExpired() {
      const current = now();
      for (const [candidateId, entry] of entries) {
        if (entry.expiresAtMs > current) continue;
        entries.delete(candidateId);
        counters.expired += 1;
      }
    }

    function diagnostics() {
      purgeExpired();
      return Object.freeze({
        runtimeRevision,
        source,
        candidateCount: entries.size,
        maxCandidates,
        maxMediaPerCandidate,
        ttlMs,
        ...counters,
      });
    }

    return Object.freeze({
      runtimeRevision,
      ingestStructured,
      lookup,
      lookupContainer,
      diagnostics,
    });
  }

  function process(source, primaryValues, structuredValues) {
    const primary = capturePolicy.normalizeMediaCandidates(source, primaryValues);
    const structured = capturePolicy.normalizeMediaCandidates(source, structuredValues);
    if (structured.length === 0) {
      return Object.freeze({ media: primary, enrichedCount: 0, structuredCount: 0 });
    }

    const unusedStructured = new Set(structured);
    const combined = [];
    let enrichedCount = 0;
    const primaryVideos = primary.filter((value) => value.kind === "video");
    const structuredVideos = structured.filter((value) => value.kind === "video");

    for (const primaryValue of primary) {
      if (primaryValue.kind !== "video") {
        combined.push(primaryValue);
        continue;
      }
      const match = structuredVideos.find((value) => (
        unusedStructured.has(value) && (
          samePoster(primaryValue, value) ||
          primaryVideos.length === 1 && structuredVideos.length === 1
        )
      ));
      if (!match) {
        combined.push(primaryValue);
        continue;
      }
      unusedStructured.delete(match);
      combined.push({
        ...primaryValue,
        ...match,
        url: primaryValue.posterUrl || primaryValue.url || match.posterUrl || match.url,
        posterUrl: primaryValue.posterUrl || primaryValue.url || match.posterUrl || match.url,
        width: primaryValue.width || match.width,
        height: primaryValue.height || match.height,
      });
      enrichedCount += 1;
    }

    for (const value of structured) {
      if (unusedStructured.has(value)) combined.push(value);
    }
    const media = capturePolicy.normalizeMediaCandidates(source, combined);
    return Object.freeze({ media, enrichedCount, structuredCount: structured.length });
  }

  function processSnapshots(source, snapshots, lookupStructured) {
    let enrichedBlockCount = 0;
    let structuredBlockCount = 0;
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      for (const block of Array.isArray(snapshot?.blocks) ? snapshot.blocks : []) {
        const structured = typeof lookupStructured === "function"
          ? lookupStructured(block?.platformId)
          : [];
        if (!Array.isArray(structured) || structured.length === 0) continue;
        structuredBlockCount += 1;
        const previousMedia = Array.isArray(block.media) ? block.media : [];
        const processed = process(source, previousMedia, structured);
        if (processed.media.length === 0) continue;
        block.media = processed.media;
        if (block.media.some((entry) => entry.kind === "video")) block.contentKind = "video";
        const recoveredCount = processed.enrichedCount > 0
          ? processed.enrichedCount
          : previousMedia.length === 0
            ? processed.media.length
            : 0;
        if (recoveredCount > 0) enrichedBlockCount += 1;
        const previousAudit = block.mediaRecovery && typeof block.mediaRecovery === "object"
          ? block.mediaRecovery
          : {};
        block.mediaRecovery = {
          ...previousAudit,
          postProcessorVersion: runtimeRevision,
          outcome: recoveredCount > 0 ? "recovered" : previousAudit.outcome,
          recoveredCount: (Number(previousAudit.recoveredCount) || 0) + recoveredCount,
          method: recoveredCount > 0 ? "structured_deferred" : previousAudit.method,
          acquisitionStage: recoveredCount > 0
            ? "structured_deferred"
            : previousAudit.acquisitionStage,
          trace: [...new Set([
            ...(Array.isArray(previousAudit.trace) ? previousAudit.trace : []),
            "structured_deferred_complete",
          ])],
        };
      }
    }
    return Object.freeze({
      requested: true,
      received: true,
      enrichedBlockCount,
      structuredBlockCount,
    });
  }

  function createDeferredInbox(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const schedule = typeof options.schedule === "function"
      ? options.schedule
      : (callback, delay) => setTimeout(callback, delay);
    const cancel = typeof options.cancel === "function" ? options.cancel : (timer) => clearTimeout(timer);
    const maxEntries = clampInteger(options.maxEntries, 1, 32, 8);
    const ttlMs = clampInteger(options.ttlMs, 250, 10_000, 2_000);
    const entries = new Map();
    const counters = { delivered: 0, expired: 0, evicted: 0 };

    function wait(requestId, waitMs = ttlMs) {
      const key = deferredRequestId(requestId);
      if (!key) return Promise.resolve(null);
      purgeExpired();
      const existing = entries.get(key);
      if (existing?.payload !== undefined) {
        entries.delete(key);
        return Promise.resolve(existing.payload);
      }
      if (existing?.promise) return existing.promise;
      const boundedWaitMs = clampInteger(waitMs, 50, ttlMs, ttlMs);
      let resolveWait;
      const promise = new Promise((resolve) => { resolveWait = resolve; });
      const entry = {
        expiresAtMs: now() + boundedWaitMs,
        promise,
        resolve: resolveWait,
        timer: null,
      };
      entry.timer = schedule(() => expire(key, entry), boundedWaitMs);
      entries.set(key, entry);
      enforceBound();
      return promise;
    }

    function deliver(requestId, payload) {
      const key = deferredRequestId(requestId);
      if (!key || !payload || typeof payload !== "object") return false;
      purgeExpired();
      const existing = entries.get(key);
      if (existing?.resolve) {
        if (existing.timer !== null) cancel(existing.timer);
        entries.delete(key);
        counters.delivered += 1;
        existing.resolve(payload);
        return true;
      }
      entries.delete(key);
      entries.set(key, { payload, expiresAtMs: now() + ttlMs });
      counters.delivered += 1;
      enforceBound();
      return true;
    }

    function expire(key, expected) {
      if (entries.get(key) !== expected) return;
      entries.delete(key);
      counters.expired += 1;
      expected.resolve?.(null);
    }

    function purgeExpired() {
      const current = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs > current) continue;
        if (entry.timer !== null && entry.timer !== undefined) cancel(entry.timer);
        entries.delete(key);
        counters.expired += 1;
        entry.resolve?.(null);
      }
    }

    function enforceBound() {
      while (entries.size > maxEntries) {
        const key = entries.keys().next().value;
        const entry = entries.get(key);
        if (entry?.timer !== null && entry?.timer !== undefined) cancel(entry.timer);
        entries.delete(key);
        counters.evicted += 1;
        entry?.resolve?.(null);
      }
    }

    function diagnostics() {
      purgeExpired();
      return Object.freeze({ runtimeRevision, entryCount: entries.size, maxEntries, ttlMs, ...counters });
    }

    return Object.freeze({ wait, deliver, diagnostics });
  }

  function deferredRequestId(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return /^[a-z0-9:_-]{1,160}$/i.test(text) ? text : null;
  }

  function samePoster(left, right) {
    const leftURL = left?.posterUrl || left?.url;
    const rightURL = right?.posterUrl || right?.url;
    return Boolean(leftURL && rightURL && assetIdentity(leftURL) === assetIdentity(rightURL));
  }

  function assetIdentity(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      url.searchParams.sort();
      return url.href;
    } catch {
      return String(value ?? "");
    }
  }

  function boundedString(value, maximum) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  globalThis.AkuMediaPostProcessor = Object.freeze({
    runtimeRevision,
    createEvidenceRuntime,
    createDeferredInbox,
    process,
    processSnapshots,
  });
})();
