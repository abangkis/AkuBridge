import {
  mediaEvidenceAdapterVersions,
  sourceAdapterVersions,
  sourceIds,
} from "./source-catalog.js";

export const BRIDGE_RUNTIME_REVISION = "source-adapters-v92";
export const BRIDGE_ID = "aku-bridge-chrome-mv3-v0";
export const BRIDGE_CONTRACT_VERSION = "aku-browser.bridge.v2";
export const BRIDGE_PROTOCOL_MAJOR = 2;
export const BRIDGE_PROTOCOL_MINOR = 0;
// Setup bootstrap authority is deliberately independent from the Chrome Web
// Store version. Release packaging updates this companion version only after
// the matching host + Sidecar installer has passed the Bridge contract checks.
export const SIDECAR_BOOTSTRAP_VERSION = "0.7.9";
export const BRIDGE_UPDATE_CAPABILITIES = Object.freeze([
  "background_check",
  "staged_apply",
  "idle_deferral",
  "rollback_status",
]);

export function createBridgeCapabilities(manifest) {
  const extensionVersion = manifest.version_name || manifest.version;
  return {
    bridgeId: BRIDGE_ID,
    extensionVersion,
    runtimeRevision: BRIDGE_RUNTIME_REVISION,
    buildId: `aku-bridge-${extensionVersion}-${BRIDGE_RUNTIME_REVISION}`,
    protocolMajor: BRIDGE_PROTOCOL_MAJOR,
    protocolMinor: BRIDGE_PROTOCOL_MINOR,
    updateCapabilities: [...BRIDGE_UPDATE_CAPABILITIES],
    adapterVersions: sourceAdapterVersions(),
    mediaEvidenceAdapterVersions: mediaEvidenceAdapterVersions(),
    contractVersion: BRIDGE_CONTRACT_VERSION,
    manifestVersion: manifest.manifest_version,
    sources: sourceIds(),
    actions: [
      "probe_readiness",
      "probe_freshness",
      "recover_source_freshness",
      "collect_visible",
      "dispatch_background_commands",
      "detect_pending_content",
      "report_adapter_health",
      "report_capture_quality",
      "acquire_missing_media",
      "recapture_missing_media",
      "cache_passive_media_evidence",
      "lookup_passive_media_evidence",
      "observe_response_media_evidence",
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

export function bridgeCapabilitiesForProtocol(capabilities, protocolMajor) {
  if (protocolMajor === BRIDGE_PROTOCOL_MAJOR) return capabilities;
  const {
    protocolMajor: _protocolMajor,
    protocolMinor: _protocolMinor,
    updateCapabilities: _updateCapabilities,
    ...legacyCapabilities
  } = capabilities;
  return legacyCapabilities;
}
