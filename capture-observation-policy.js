export function observationEvidenceBlockCount(observation) {
  return (observation?.snapshots ?? []).reduce(
    (total, snapshot) => total + (Array.isArray(snapshot?.blocks) ? snapshot.blocks.length : 0),
    0,
  );
}

export function emptyCaptureDiagnostics(observation) {
  const coverage = observation?.coverage ?? {};
  const latestSnapshot = (observation?.snapshots ?? []).at(-1) ?? {};
  const selectorCandidateCount =
    coverage.sourceSelectorCandidateCount ?? latestSnapshot.selectorCandidateCount ?? 0;
  const visibleSelectorCandidateCount =
    coverage.sourceVisibleSelectorCandidateCount ?? latestSnapshot.visibleContainerCount ?? 0;
  const observedBlockCount = coverage.observedBlockCount ?? 0;
  return {
    source: observation?.source ?? null,
    adapterVersion: coverage.adapterVersion ?? latestSnapshot.adapterVersion ?? null,
    adapterState: coverage.adapterHealth?.state ?? null,
    selectorStrategy: latestSnapshot.selectorStrategy ?? null,
    selectorCounts: coverage.adapterHealth?.selectorCounts ?? latestSnapshot.selectorCounts ?? {},
    selectorCandidateCount,
    visibleSelectorCandidateCount,
    readinessState: coverage.sourceReadinessState ?? null,
    readinessWaitMs: coverage.sourceReadinessWaitMs ?? 0,
    captureVisibilityMode: coverage.captureVisibilityMode ?? null,
    captureSurfaceReason: coverage.captureSurfaceReason ?? null,
    snapshotCount: coverage.snapshotCount ?? observation?.snapshots?.length ?? 0,
    observedBlockCount,
    captureFailureReason: observedBlockCount > 0
      ? null
      : visibleSelectorCandidateCount > 0
        ? "visible_candidates_without_usable_blocks"
        : selectorCandidateCount > 0
          ? "candidates_not_visible_or_not_observed"
          : "no_capture_candidates",
    candidateDiagnostics: latestSnapshot.candidateDiagnostics ?? null,
    captureQuality: coverage.captureQuality ?? null,
    structuredFeedFallback: coverage.structuredFeedFallback ?? null,
  };
}
