(() => {
  const runtimeRevision = "media-post-processor-v1";
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
    process,
  });
})();
