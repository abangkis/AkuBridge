(() => {
  const runtimeRevision = "media-recovery-runtime-v1";
  const policyVersion = "media-recovery-v1";
  const sourceAdapters = globalThis.AkuSourceAdapters;
  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  if (!sourceAdapters) throw new Error("AkuBridge source-adapter runtime was not loaded.");
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");

  async function recover({
    source,
    container,
    excludeRoot = null,
    initialMedia = [],
    mediaRootDetected = false,
    attemptsAvailable = 0,
    deadlineAtMs = Number.POSITIVE_INFINITY,
    extractPrimary,
    delay,
  }) {
    const adapter = sourceAdapters.get(source);
    const strategy = adapter.mediaRecovery;
    const base = {
      policyVersion,
      strategyVersion: strategy?.version ?? "unsupported",
      source,
      attempts: 0,
      recoveredCount: 0,
      method: "none",
      limitation: "",
      trace: [],
    };
    const primary = normalizeMedia(source, initialMedia);
    if (primary.length > 0) {
      return result(primary, {
        ...base,
        outcome: "primary_complete",
        trace: ["primary_complete"],
      });
    }
    if (!mediaRootDetected) {
      return result([], {
        ...base,
        outcome: "not_applicable",
        trace: ["primary_missing", "media_root_absent"],
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
        limitation: "Rendered media was detected but no bounded recovery attempt was available.",
        trace: ["primary_missing", "media_root_detected", "attempt_unavailable"],
      });
    }

    const maximumAttempts = Math.min(
      Math.max(0, Math.trunc(attemptsAvailable)),
      clampInteger(strategy.maxAttempts, 1, 1, 1),
    );
    let attempts = 0;
    const trace = ["primary_missing", "media_root_detected"];
    for (; attempts < maximumAttempts && Date.now() < deadlineAtMs; attempts += 1) {
      await delay(clampInteger(strategy.settleMs, 100, 2_000, 700));
      const hydrated = normalizeMedia(source, extractPrimary?.() ?? []);
      if (hydrated.length > 0) {
        return result(hydrated, {
          ...base,
          outcome: "recovered",
          attempts: attempts + 1,
          recoveredCount: hydrated.length,
          method: "primary_hydration",
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
      if (alternate.length > 0) {
        return result(alternate, {
          ...base,
          outcome: "recovered",
          attempts: attempts + 1,
          recoveredCount: alternate.length,
          method: "alternate_dom",
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
      limitation: "Rendered media remained unavailable after the bounded adapter recovery.",
      trace,
    });
  }

  function summarize(values) {
    const recoveries = Array.isArray(values) ? values.filter(Boolean) : [];
    const outcomes = Object.fromEntries(
      ["not_applicable", "primary_complete", "recovered", "unavailable"].map((outcome) => [
        outcome,
        recoveries.filter((entry) => entry.outcome === outcome).length,
      ]),
    );
    return Object.freeze({
      policyVersion,
      candidateCount: recoveries.length,
      outcomes: Object.freeze(outcomes),
      attempts: recoveries.reduce((sum, entry) => sum + (entry.attempts ?? 0), 0),
      recoveredMediaCount: recoveries.reduce(
        (sum, entry) => sum + (entry.recoveredCount ?? 0),
        0,
      ),
      methods: Object.freeze([...new Set(
        recoveries.map((entry) => entry.method).filter((method) => method && method !== "none"),
      )]),
      stageCounts: Object.freeze(recoveries
        .flatMap((entry) => entry.trace ?? [])
        .reduce((counts, stage) => {
          counts[stage] = (counts[stage] ?? 0) + 1;
          return counts;
        }, {})),
    });
  }

  function collectRootCandidates(root, { kind = "image", alt = "" } = {}) {
    if (!root) return [];
    const elements = uniqueElements([
      root,
      ...(root.querySelectorAll?.("img,video,source,[style]") ?? []),
    ]);
    const backgrounds = uniqueElements([root, ...(root.querySelectorAll?.("*") ?? [])])
      .map((element) => capturePolicy.mediaUrlFromCssBackground(
        element.style?.backgroundImage || getComputedStyle(element).backgroundImage,
      ))
      .filter(Boolean);
    const imageUrls = elements.flatMap((element) => {
      if (String(element.tagName ?? "").toLowerCase() === "source") return [];
      return attributeUrls(element, [
        "currentSrc",
        "src",
        "poster",
        "data-src",
        "data-delayed-url",
        "data-ghost-url",
        "data-image-url",
      ]);
    });
    const srcsetUrls = elements.flatMap((element) => parseSrcset(
      element.srcset || element.getAttribute?.("srcset"),
    ));
    const playbackUrl = kind === "video"
      ? elements.flatMap((element) => {
          const tag = String(element.tagName ?? "").toLowerCase();
          return tag === "video" || tag === "source"
            ? attributeUrls(element, ["currentSrc", "src"])
            : [];
        }).find((url) => /^https:\/\/(?:video\.twimg\.com|[^/]+\.licdn\.com)\//i.test(url)) ?? null
      : null;
    const urls = [...new Set([...imageUrls, ...srcsetUrls, ...backgrounds])]
      .filter((url) => !playbackUrl || url !== playbackUrl);
    const rect = root.getBoundingClientRect?.() ?? {};
    const width = Math.max(0, Math.round(rect.width || root.naturalWidth || root.videoWidth || 0));
    const height = Math.max(0, Math.round(rect.height || root.naturalHeight || root.videoHeight || 0));
    const label = String(
      alt || root.getAttribute?.("aria-label") || root.querySelector?.("img")?.alt ||
      (kind === "video" ? "Video preview" : "Image"),
    );
    return urls.map((url) => ({
      kind,
      url,
      posterUrl: kind === "video" ? url : null,
      playbackUrl,
      playbackMode: kind === "video" && playbackUrl ? "inline" : kind === "video" ? "native" : null,
      alt: label,
      width,
      height,
    }));
  }

  function attributeUrls(element, properties) {
    return properties.flatMap((property) => {
      const direct = element?.[property];
      const attribute = element?.getAttribute?.(property);
      return [direct, attribute];
    }).filter((value) => typeof value === "string" && /^https:\/\//i.test(value));
  }

  function parseSrcset(value) {
    return typeof value === "string"
      ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean)
      : [];
  }

  function normalizeMedia(source, values) {
    return [...capturePolicy.normalizeMediaCandidates(source, values)];
  }

  function result(media, audit) {
    return Object.freeze({
      media: Object.freeze(media),
      audit: Object.freeze({
        ...audit,
        trace: Object.freeze([...(audit.trace ?? [])]),
      }),
    });
  }

  function uniqueElements(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  }

  globalThis.AkuMediaRecoveryRuntime = Object.freeze({
    runtimeRevision,
    policyVersion,
    recover,
    summarize,
  });
})();
