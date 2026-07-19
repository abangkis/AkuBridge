(() => {
  const runtimeRevision = "source-adapters-v12";

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
    const minimumBlockCharacters = adapter.captureTuning?.minimumBlockCharacters;
    if (minimumBlockCharacters !== undefined &&
        (!Number.isInteger(minimumBlockCharacters) || minimumBlockCharacters < 1 || minimumBlockCharacters > 40)) {
      throw new Error(
        `AkuBridge ${adapter.source} adapter minimum block length must be between 1 and 40 characters.`,
      );
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
      freshnessVersion: adapter.freshness.version,
      mediaAcquisitionVersion: adapter.mediaAcquisition.version,
      scrollStepMultiplier: adapter.captureTuning?.scrollStepMultiplier ?? 1,
      minimumBlockCharacters: adapter.captureTuning?.minimumBlockCharacters ?? 40,
      actions: [
        "probe_readiness",
        ...(typeof adapter.availability === "function" ? ["report_source_availability"] : []),
        "probe_freshness",
        ...(adapter.freshness.revealSupported ? ["reveal_pending_content"] : []),
        "collect_visible",
        "detect_pending_content",
        "report_adapter_health",
        "report_capture_quality",
        "acquire_missing_media",
        "extract_source_semantics",
        "report_frontier",
        "report_source_events",
      ],
    }));
  }

  globalThis.AkuSourceAdapters = Object.freeze({
    runtimeRevision,
    register,
    get,
    capabilities,
  });
})();
