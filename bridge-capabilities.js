export const BRIDGE_RUNTIME_REVISION = "source-fidelity-v48";
export const BRIDGE_ID = "aku-bridge-chrome-mv3-v0";
export const BRIDGE_CONTRACT_VERSION = "aku-browser.bridge.v2";

export function createBridgeCapabilities(manifest) {
  return {
    bridgeId: BRIDGE_ID,
    extensionVersion: manifest.version,
    runtimeRevision: BRIDGE_RUNTIME_REVISION,
    buildId: `aku-bridge-${manifest.version}-${BRIDGE_RUNTIME_REVISION}`,
    adapterVersions: { x: "x-dom-v16", linkedin: "linkedin-dom-v13" },
    contractVersion: BRIDGE_CONTRACT_VERSION,
    manifestVersion: manifest.manifest_version,
    sources: ["x", "linkedin"],
    actions: [
      "probe_readiness",
      "probe_freshness",
      "recover_source_freshness",
      "collect_visible",
      "detect_pending_content",
      "report_adapter_health",
      "report_capture_quality",
      "recover_missing_media",
      "extract_source_semantics",
      "report_frontier",
      "manage_source_tab_lifecycle",
      "manage_capture_window",
      "release_capture_surface",
      "preserve_working_tab",
      "report_source_events",
      "reload_self",
    ],
    authority: "read_only_bounded",
    captureLimits: { maxScrolls: 6, maxSnapshots: 7, maxBlocksPerSnapshot: 20 },
  };
}
