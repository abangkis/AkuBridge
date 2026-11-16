(() => {
  if (globalThis.AkuBridgeDiagnostics) return;
  const stages = new Set(["idle", "capture_started", "snapshot_started", "snapshot_completed", "scrolling",
    "scroll_settling", "restoring_scroll", "capture_completed", "snapshot_candidates_ready",
    "permalink_recovery_started", "permalink_recovery_completed", "extracting_block", "quality_retry"]);
  const numbers = ["scrolls", "snapshotIndex", "blockCount", "observedBlockCount", "afterSnapshotIndex",
    "milliseconds", "visibleContainerCount", "boundedContainerCount", "containerIndex", "attempt"];
  const own = (value, key) => value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const revision = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value);
  const validAttempt = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  function details(value) {
    const result = {}, source = own(value, "source"), strategy = own(value, "strategy");
    if (["x", "instagram", "linkedin", "facebook"].includes(source)) result.source = source;
    for (const key of numbers) {
      const number = own(value, key);
      if (Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000) result[key] = number;
    }
    if (["next_candidate", "viewport"].includes(strategy)) result.strategy = strategy;
    return result;
  }
  function project(value) {
    const stage = own(value, "stage");
    if (!stages.has(stage)) return null;
    const result = {};
    for (const key of ["runtimeRevision", "adapterRuntimeRevision"]) {
      const field = own(value, key);
      if (revision(field)) result[key] = field;
    }
    result.stage = stage;
    Object.assign(result, details(value));
    const at = own(value, "updatedAt");
    if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) && at.length <= 32) result.updatedAt = at;
    return Object.freeze(result);
  }
  function createProgress({ runtimeRevision, adapterRuntimeRevision, clock }) {
    const recorder = globalThis.AkuDiagnosticRecorder.create("capture");
    let latest = null;
    return Object.freeze({
      update(stage, fields = {}) {
        if (!stages.has(stage)) return latest;
        recorder.advance(stage);
        if (stage === "capture_started") recorder.disposition("started");
        if (stage === "capture_completed") { recorder.completed(stage); recorder.disposition("completed"); }
        latest = project({ runtimeRevision, adapterRuntimeRevision, stage, ...details(fields), updatedAt: clock() });
        return latest;
      },
      latest: () => latest,
      snapshot: () => recorder.snapshot(),
      incomplete: () => recorder.incomplete(),
    });
  }
  globalThis.AkuBridgeDiagnostics = Object.freeze({ createProgress, project, details, validAttempt });
})();
