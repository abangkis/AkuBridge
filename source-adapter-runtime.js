(() => {
  const runtimeRevision = "source-adapters-v16";
  const supportedContentFamilies = new Set(["feed_post"]);
  const supportedEvidenceModalities = new Set([
    "text",
    "image",
    "video",
    "attachment",
    "quoted_post",
  ]);
  const supportedReadinessRecoveryActions = new Set([
    "recreate_managed_surface",
  ]);

  const adapters = new Map();

  function register(adapter) {
    if (!adapter?.source || typeof adapter.source !== "string") {
      throw new Error("AkuBridge source adapter requires a source id.");
    }
    if (adapters.has(adapter.source)) {
      throw new Error(`AkuBridge source adapter already registered: ${adapter.source}.`);
    }
    for (const method of ["matchesPage", "discoverCandidates", "findAuthor", "extractSemantics"]) {
      if (typeof adapter[method] !== "function") {
        throw new Error(`AkuBridge ${adapter.source} adapter is missing ${method}().`);
      }
    }
    if (typeof adapter.qualityProfile !== "string" || !adapter.qualityProfile) {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a quality profile.`);
    }
    if (!adapter.evidenceProfile || typeof adapter.evidenceProfile !== "object") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires an evidence profile.`);
    }
    if (!supportedContentFamilies.has(adapter.evidenceProfile.contentFamily)) {
      throw new Error(`AkuBridge ${adapter.source} adapter has an unsupported content family.`);
    }
    if (!Array.isArray(adapter.evidenceProfile.modalities) ||
        adapter.evidenceProfile.modalities.length === 0 ||
        adapter.evidenceProfile.modalities.some((value) => !supportedEvidenceModalities.has(value))) {
      throw new Error(`AkuBridge ${adapter.source} adapter has invalid evidence modalities.`);
    }
    if (!adapter.qualitySelectors || typeof adapter.qualitySelectors !== "object") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires quality selectors.`);
    }
    if (!adapter.freshness || typeof adapter.freshness !== "object") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a freshness strategy.`);
    }
    if (typeof adapter.freshness.pendingContentPattern?.test !== "function") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a pending-content pattern.`);
    }
    if (typeof adapter.freshness.version !== "string" || !adapter.freshness.version) {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a freshness version.`);
    }
    if (adapter.freshness.revealSupported === true &&
        (!Number.isInteger(adapter.freshness.revealObservationMs) ||
          adapter.freshness.revealObservationMs < 500)) {
      throw new Error(
        `AkuBridge ${adapter.source} adapter requires a bounded reveal observation window.`,
      );
    }
    if (!adapter.mediaAcquisition || typeof adapter.mediaAcquisition !== "object") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a media-acquisition strategy.`);
    }
    if (!Array.isArray(adapter.mediaHosts) || adapter.mediaHosts.length === 0 ||
        adapter.mediaHosts.some((host) => typeof host !== "string" || !host)) {
      throw new Error(`AkuBridge ${adapter.source} adapter requires bounded media hosts.`);
    }
    if (typeof adapter.mediaAcquisition.version !== "string" || !adapter.mediaAcquisition.version) {
      throw new Error(`AkuBridge ${adapter.source} adapter requires a media-acquisition version.`);
    }
    if (typeof adapter.mediaAcquisition.detectExpectedKinds !== "function") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires media-kind detection.`);
    }
    if (typeof adapter.mediaAcquisition.extractCandidates !== "function") {
      throw new Error(`AkuBridge ${adapter.source} adapter requires media acquisition extraction.`);
    }
    const scrollStepMultiplier = adapter.captureTuning?.scrollStepMultiplier;
    if (scrollStepMultiplier !== undefined &&
        (!Number.isFinite(scrollStepMultiplier) || scrollStepMultiplier < 1 || scrollStepMultiplier > 2)) {
      throw new Error(
        `AkuBridge ${adapter.source} adapter scroll-step multiplier must be between 1 and 2.`,
      );
    }
    const scrollStrategy = adapter.captureTuning?.scrollStrategy;
    if (scrollStrategy !== undefined && !["viewport", "next_candidate"].includes(scrollStrategy)) {
      throw new Error(
        `AkuBridge ${adapter.source} adapter has an unsupported scroll strategy.`,
      );
    }
    if (adapter.assessReadiness !== undefined && typeof adapter.assessReadiness !== "function") {
      throw new Error(`AkuBridge ${adapter.source} adapter readiness assessment must be a function.`);
    }
    adapters.set(adapter.source, Object.freeze({ ...adapter }));
  }

  function get(source) {
    const adapter = adapters.get(source);
    if (!adapter) throw new Error(`AkuBridge has no loaded source adapter for ${source}.`);
    return adapter;
  }

  function capabilities() {
    return [...adapters.values()].map((adapter) => ({
      source: adapter.source,
      version: adapter.version,
      qualityProfile: adapter.qualityProfile,
      contentFamily: adapter.evidenceProfile.contentFamily,
      evidenceModalities: [...adapter.evidenceProfile.modalities],
      freshnessVersion: adapter.freshness.version,
      mediaAcquisitionVersion: adapter.mediaAcquisition.version,
      scrollStepMultiplier: adapter.captureTuning?.scrollStepMultiplier ?? 1,
      scrollStrategy: adapter.captureTuning?.scrollStrategy ?? "viewport",
      actions: [
        "probe_readiness",
        ...(typeof adapter.assessReadiness === "function" ? ["diagnose_readiness"] : []),
        ...(typeof adapter.availability === "function" ? ["report_source_availability"] : []),
        "probe_freshness",
        ...(adapter.freshness.revealSupported ? ["reveal_pending_content"] : []),
        "collect_visible",
        "detect_pending_content",
        "report_adapter_health",
        "report_capture_quality",
        "acquire_missing_media",
        "extract_source_semantics",
        "extract_origin_signals",
        "report_frontier",
        "report_source_events",
      ],
    }));
  }

  function assessReadiness(source, context) {
    const adapter = get(source);
    if (typeof adapter.assessReadiness !== "function") return null;
    const assessment = adapter.assessReadiness(Object.freeze({ ...context }));
    if (!assessment || typeof assessment !== "object") {
      throw new Error(`AkuBridge ${source} adapter returned an invalid readiness assessment.`);
    }
    const state = String(assessment.state ?? context?.state ?? "").trim().slice(0, 80);
    const diagnosis = String(assessment.diagnosis ?? "").trim().slice(0, 120);
    if (!state || !diagnosis) {
      throw new Error(`AkuBridge ${source} adapter readiness assessment requires state and diagnosis.`);
    }
    let recovery = null;
    if (assessment.recovery !== undefined && assessment.recovery !== null) {
      const action = String(assessment.recovery.action ?? "").trim();
      const reason = String(assessment.recovery.reason ?? diagnosis).trim().slice(0, 120);
      const maxAttempts = Number(assessment.recovery.maxAttempts ?? 0);
      if (!supportedReadinessRecoveryActions.has(action) || !reason || maxAttempts !== 1) {
        throw new Error(`AkuBridge ${source} adapter returned an invalid readiness recovery hint.`);
      }
      recovery = Object.freeze({ action, reason, maxAttempts });
    }
    return Object.freeze({ state, diagnosis, recovery });
  }

  function extractOriginSignals(container, contract = {}) {
    const source = String(contract.source ?? "").trim().slice(0, 40);
    const definitions = Array.isArray(contract.definitions) ? contract.definitions : [];
    const result = [];
    const seen = new Set();
    for (const definition of definitions) {
      const kind = String(definition?.kind ?? "").trim();
      const scope = String(definition?.scope ?? "").trim();
      if (!["platform_ai_label", "content_credentials"].includes(kind) ||
          !["social_post", "attached_media", "author_account"].includes(scope)) {
        continue;
      }
      const labels = new Map((definition.labels ?? []).map((label) => {
        const bounded = String(label ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
        return [bounded.toLocaleLowerCase(), bounded];
      }).filter(([label]) => label));
      if (!labels.size) continue;
      const selector = definition.selector || '[aria-label],[title],[role="button"],button,a';
      for (const element of container?.querySelectorAll?.(selector) ?? []) {
        const candidates = [
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.innerText,
          element.textContent,
        ];
        for (const candidate of candidates) {
          const normalized = String(candidate ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
          const label = labels.get(normalized.toLocaleLowerCase());
          if (!label) continue;
          const key = `${kind}\u0000${scope}\u0000${label.toLocaleLowerCase()}`;
          if (seen.has(key)) break;
          seen.add(key);
          result.push(Object.freeze({
            kind,
            scope,
            authority: "platform",
            label,
            source,
          }));
          break;
        }
      }
    }
    return result.slice(0, 8);
  }

  globalThis.AkuSourceAdapters = Object.freeze({
    runtimeRevision,
    register,
    get,
    capabilities,
    assessReadiness,
    extractOriginSignals,
  });
})();
