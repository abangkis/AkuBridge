export const TAB_COMPLETE_OR_SOURCE_READY = "tab_complete_or_source_ready";

export function navigationReadinessOutcome({
  mode,
  tabStatus,
  readiness,
  expectedSource,
  expectedAdapterVersion,
  expectedRuntimeRevision,
  canonicalFeed,
}) {
  if (tabStatus === "complete") {
    return Object.freeze({ ready: true, reason: "tab_complete" });
  }
  if (mode !== TAB_COMPLETE_OR_SOURCE_READY) {
    return Object.freeze({ ready: false, reason: "tab_loading" });
  }
  if (canonicalFeed !== true) {
    return Object.freeze({ ready: false, reason: "noncanonical_feed" });
  }
  if (!readiness || readiness.source !== expectedSource) {
    return Object.freeze({ ready: false, reason: "source_mismatch" });
  }
  if (
    readiness.adapterVersion !== expectedAdapterVersion ||
    readiness.runtimeRevision !== expectedRuntimeRevision
  ) {
    return Object.freeze({ ready: false, reason: "runtime_mismatch" });
  }
  if (
    readiness.state !== "feed_ready" ||
    readiness.feedRootPresent !== true ||
    Number(readiness.visibleSelectorCandidateCount ?? 0) < 1
  ) {
    return Object.freeze({ ready: false, reason: "source_not_ready" });
  }
  return Object.freeze({ ready: true, reason: "source_ready" });
}
