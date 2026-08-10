(() => {
  const runtimeRevision = "media-acquisition-engine-v4";
  const policyVersion = "media-acquisition-v2";
  const sourceAdapters = globalThis.AkuSourceAdapters;
  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  const mediaPostProcessor = globalThis.AkuMediaPostProcessor;
  if (!sourceAdapters) throw new Error("AkuBridge source-adapter runtime was not loaded.");
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");
  if (!mediaPostProcessor) throw new Error("AkuBridge media-post processor was not loaded.");

  async function acquire({
    source,
    container,
    excludeRoot = null,
    initialMedia = [],
    mediaRootDetected = false,
    attemptsAvailable = 0,
    settleMs = null,
    deadlineAtMs = Number.POSITIVE_INFINITY,
    captureVisibilityMode = "same_window",
    extractPrimary,
    delay,
  }) {
    const adapter = sourceAdapters.get(source);
    const strategy = adapter.mediaAcquisition;
    const candidateDiagnostics = [];
    recordDiagnostics(candidateDiagnostics, "initial_dom", initialMedia);
    const expectedKinds = normalizeKinds(strategy.detectExpectedKinds(container, {
      excludeRoot,
      uniqueElements,
    }));
    const base = {
      policyVersion,
      engineVersion: runtimeRevision,
      postProcessorVersion: mediaPostProcessor.runtimeRevision,
      strategyVersion: strategy?.version ?? "unsupported",
      source,
      expectedKinds,
      attempts: 0,
      recoveredCount: 0,
      method: "none",
      acquisitionStage: "none",
      visibilityRequirement: "none",
      foregroundRequired: false,
      limitation: "",
      trace: [],
      candidateDiagnostics,
    };
    const primary = normalizeMedia(source, initialMedia);
    const structured = normalizeMedia(
      source,
      strategy.extractStructuredCandidates?.(container, {
        excludeRoot,
        collectRootCandidates,
        uniqueElements,
      }) ?? [],
    );
    recordDiagnostics(candidateDiagnostics, "structured_state", structured);
    const processed = mediaPostProcessor.process(source, primary, structured);
    if (processed.media.length > 0) {
      const enriched = processed.enrichedCount > 0;
      const structuredOnly = primary.length === 0 && structured.length > 0;
      return result(processed.media, {
        ...base,
        outcome: enriched || structuredOnly ? "recovered" : "primary_complete",
        recoveredCount: enriched ? processed.enrichedCount : structuredOnly ? processed.media.length : 0,
        method: enriched ? "structured_enrichment" : structuredOnly ? "structured_state" : "none",
        acquisitionStage: enriched
          ? "structured_enrichment"
          : structuredOnly
            ? "structured_state"
            : "primary_dom",
        trace: enriched
          ? ["primary_complete", "structured_enrichment_complete"]
          : structuredOnly
            ? ["primary_missing", "structured_state_complete"]
            : ["primary_complete"],
      });
    }
    if (!mediaRootDetected && expectedKinds.length === 0) {
      return result([], {
        ...base,
        outcome: "not_applicable",
        trace: ["primary_missing", "media_root_absent"],
      });
    }

    if (
      captureVisibilityMode === "managed_window" &&
      strategy.quietRecovery === "foreground_required"
    ) {
      return result([], {
        ...base,
        outcome: "unavailable",
        visibilityRequirement: "foreground_window",
        foregroundRequired: true,
        limitation: "The source exposed a media container but requires foreground visibility before its media URL becomes available.",
        trace: [
          "primary_missing",
          "media_root_detected",
          "structured_state_empty",
          "quiet_recovery_unsupported",
        ],
      });
    }

    if (
      !strategy ||
      typeof strategy.extractCandidates !== "function" ||
      attemptsAvailable < 1 ||
      Date.now() >= deadlineAtMs
    ) {
      return result([], {
        ...base,
        outcome: "unavailable",
        ...foregroundRequirement(strategy, captureVisibilityMode),
        limitation: "Rendered media was detected but no bounded acquisition attempt was available.",
        trace: ["primary_missing", "media_root_detected", "attempt_unavailable"],
      });
    }

    const maximumAttempts = Math.min(
      Math.max(0, Math.trunc(attemptsAvailable)),
      clampInteger(strategy.maxAttempts, 1, 1, 1),
    );
    let attempts = 0;
    const trace = ["primary_missing", "media_root_detected", "structured_state_empty"];
    for (; attempts < maximumAttempts && Date.now() < deadlineAtMs; attempts += 1) {
      await delay(clampInteger(settleMs ?? strategy.settleMs, 100, 2_000, 700));
      const hydrated = normalizeMedia(source, extractPrimary?.() ?? []);
      recordDiagnostics(candidateDiagnostics, "primary_hydration", hydrated);
      if (hydrated.length > 0) {
        return result(hydrated, {
          ...base,
          outcome: "recovered",
          attempts: attempts + 1,
          recoveredCount: hydrated.length,
          method: "primary_hydration",
          acquisitionStage: "hydrated_dom",
          trace: [...trace, "primary_hydration_complete"],
        });
      }
      trace.push("primary_hydration_empty");
      const alternate = normalizeMedia(
        source,
        strategy.extractCandidates(container, {
          excludeRoot,
          collectRootCandidates,
          uniqueElements,
        }),
      );
      recordDiagnostics(candidateDiagnostics, "alternate_dom", alternate);
      if (alternate.length > 0) {
        return result(alternate, {
          ...base,
          outcome: "recovered",
          attempts: attempts + 1,
          recoveredCount: alternate.length,
          method: "alternate_dom",
          acquisitionStage: "alternate_dom",
          trace: [...trace, "alternate_dom_complete"],
        });
      }
      trace.push("alternate_dom_empty");
    }
    if (Date.now() >= deadlineAtMs) trace.push("deadline_exhausted");
    return result([], {
      ...base,
      outcome: "unavailable",
      attempts,
      ...foregroundRequirement(strategy, captureVisibilityMode),
      limitation: "Rendered media remained unavailable after bounded acquisition.",
      trace,
    });
  }

  function summarize(values) {
    const audits = (Array.isArray(values) ? values : []).filter(Boolean);
    const summary = {
      policyVersion,
      engineVersion: runtimeRevision,
      candidateCount: audits.length,
      attempts: 0,
      recoveredMediaCount: 0,
      foregroundRequiredCount: 0,
      expectedKindCounts: {},
      outcomes: { primary_complete: 0, recovered: 0, unavailable: 0, not_applicable: 0 },
      methods: [],
      stageCounts: {},
    };
    for (const audit of audits) {
      summary.attempts += Number(audit.attempts ?? 0);
      summary.recoveredMediaCount += Number(audit.recoveredCount ?? 0);
      if (audit.foregroundRequired === true) summary.foregroundRequiredCount += 1;
      if (Object.hasOwn(summary.outcomes, audit.outcome)) summary.outcomes[audit.outcome] += 1;
      if (audit.method && audit.method !== "none" && !summary.methods.includes(audit.method)) {
        summary.methods.push(audit.method);
      }
      for (const kind of normalizeKinds(audit.expectedKinds)) {
        summary.expectedKindCounts[kind] = (summary.expectedKindCounts[kind] ?? 0) + 1;
      }
      for (const stage of Array.isArray(audit.trace) ? audit.trace : []) {
        summary.stageCounts[stage] = (summary.stageCounts[stage] ?? 0) + 1;
      }
    }
    return summary;
  }

  function collectRootCandidates(root, { kind = "image", alt = "" } = {}) {
    const values = [];
    for (const image of root.matches?.("img") ? [root] : root.querySelectorAll?.("img") ?? []) {
      const rect = image.getBoundingClientRect?.() ?? {};
      for (const url of imageUrls(image)) {
        values.push({ kind, url, posterUrl: kind === "video" ? url : null, alt: image.alt || alt, width: rect.width, height: rect.height });
      }
    }
    for (const video of root.matches?.("video") ? [root] : root.querySelectorAll?.("video") ?? []) {
      const rect = video.getBoundingClientRect?.() ?? {};
      const playbackUrl = [
        video.currentSrc,
        video.src,
        ...[...(video.querySelectorAll?.("source[src]") ?? [])].map((entry) => entry.src),
      ].find((value) => /^https:\/\//i.test(value ?? ""));
      const posterUrl = video.poster || video.getAttribute?.("poster") || renderedBackgroundUrl(video);
      values.push({
        kind: "video",
        url: posterUrl,
        posterUrl,
        playbackUrl,
        playbackMode: playbackUrl ? "inline" : "native",
        alt: video.getAttribute?.("aria-label") || alt || "Video preview",
        width: rect.width,
        height: rect.height,
      });
    }
    for (const element of uniqueElements([root, ...(root.querySelectorAll?.("*") ?? [])])) {
      const backgroundUrl = renderedBackgroundUrl(element);
      if (!backgroundUrl) continue;
      const rect = element.getBoundingClientRect?.() ?? root.getBoundingClientRect?.() ?? {};
      values.push({ kind, url: backgroundUrl, posterUrl: kind === "video" ? backgroundUrl : null, alt, width: rect.width, height: rect.height });
    }
    return values;
  }

  function imageUrls(image) {
    if (!image) return [];
    const srcsets = [image.srcset, image.getAttribute?.("srcset")].filter(Boolean);
    const srcsetUrls = srcsets.flatMap((srcset) => String(srcset).split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter(Boolean));
    return [...new Set([
      image.currentSrc,
      image.src,
      image.getAttribute?.("src"),
      image.getAttribute?.("data-src"),
      image.getAttribute?.("data-original"),
      ...srcsetUrls,
    ].filter(Boolean))];
  }

  function renderedBackgroundUrl(element) {
    if (!element) return null;
    try {
      const value = element.style?.backgroundImage || globalThis.getComputedStyle?.(element)?.backgroundImage;
      return capturePolicy.mediaUrlFromCssBackground(value);
    } catch {
      return null;
    }
  }

  function normalizeMedia(source, values) {
    if (Array.isArray(values) && values.diagnostics) return values;
    return capturePolicy.normalizeMediaCandidates(source, Array.isArray(values) ? values : []);
  }

  function recordDiagnostics(target, stage, values) {
    const diagnostics = values?.diagnostics;
    if (!diagnostics || typeof diagnostics !== "object") return;
    target.push(Object.freeze({
      stage,
      candidateCount: Number(diagnostics.candidateCount ?? 0),
      urlPresentCount: Number(diagnostics.urlPresentCount ?? 0),
      urlMissingCount: Number(diagnostics.urlMissingCount ?? 0),
      rejectedHostCount: Number(diagnostics.rejectedHostCount ?? 0),
      rejectedGeometryCount: Number(diagnostics.rejectedGeometryCount ?? 0),
      duplicateCount: Number(diagnostics.duplicateCount ?? 0),
      acceptedCount: Number(diagnostics.acceptedCount ?? 0),
      trustedUnknownGeometryAcceptedCount: Number(diagnostics.trustedUnknownGeometryAcceptedCount ?? 0),
      urlSources: Object.freeze({ ...(diagnostics.urlSources ?? {}) }),
    }));
  }

  function normalizeKinds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => ["image", "video", "document", "unknown"].includes(value)))];
  }

  function foregroundRequirement(strategy, captureVisibilityMode) {
    const required = captureVisibilityMode === "managed_window" &&
      strategy?.foregroundAfterQuietExhaustion === true;
    return required ? {
      visibilityRequirement: "foreground_window",
      foregroundRequired: true,
    } : {};
  }

  function uniqueElements(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  }

  function result(media, audit) {
    return Object.freeze({ media: Object.freeze([...media]), audit: Object.freeze(audit) });
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  globalThis.AkuMediaAcquisitionEngine = Object.freeze({
    runtimeRevision,
    policyVersion,
    acquire,
    summarize,
  });
})();
