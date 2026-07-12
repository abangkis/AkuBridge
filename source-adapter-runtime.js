(() => {
  const runtimeRevision = "source-adapters-v3";
  if (globalThis.AkuSourceAdapters?.runtimeRevision === runtimeRevision) return;

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
      actions: [
        "probe_readiness",
        "collect_visible",
        "detect_pending_content",
        "report_adapter_health",
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
