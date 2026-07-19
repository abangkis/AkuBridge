export function observationEvidenceBlockCount(observation) {
  return (observation?.snapshots ?? []).reduce(
    (total, snapshot) => total + (Array.isArray(snapshot?.blocks) ? snapshot.blocks.length : 0),
    0,
  );
}

export function emptyCaptureDiagnostics(observation) {
  const coverage = observation?.coverage ?? {};
  const latestSnapshot = (observation?.snapshots ?? []).at(-1) ?? {};
  return {
    source: observation?.source ?? null,
    adapterVersion: coverage.adapterVersion ?? latestSnapshot.adapterVersion ?? null,
    adapterState: coverage.adapterHealth?.state ?? null,
    selectorStrategy: latestSnapshot.selectorStrategy ?? null,
    selectorCounts: coverage.adapterHealth?.selectorCounts ?? latestSnapshot.selectorCounts ?? {},
    selectorCandidateCount:
      coverage.sourceSelectorCandidateCount ?? latestSnapshot.selectorCandidateCount ?? 0,
    visibleSelectorCandidateCount:
      coverage.sourceVisibleSelectorCandidateCount ?? latestSnapshot.visibleContainerCount ?? 0,
    readinessState: coverage.sourceReadinessState ?? null,
    readinessWaitMs: coverage.sourceReadinessWaitMs ?? 0,
    captureVisibilityMode: coverage.captureVisibilityMode ?? null,
    captureSurfaceReason: coverage.captureSurfaceReason ?? null,
    snapshotCount: coverage.snapshotCount ?? observation?.snapshots?.length ?? 0,
    observedBlockCount: coverage.observedBlockCount ?? 0,
  };
}
