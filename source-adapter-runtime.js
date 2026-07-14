(() => {
  const runtimeRevision = "source-adapters-v6";

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
      actions: [
        "probe_readiness",
        "probe_freshness",
        ...(adapter.freshness.revealSupported ? ["reveal_pending_content"] : []),
        "collect_visible",
        "detect_pending_content",
        "report_adapter_health",
        "report_capture_quality",
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
