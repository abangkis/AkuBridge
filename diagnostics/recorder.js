(() => {
  if (globalThis.AkuDiagnosticRecorder) return;
  const label = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
  const observed = value => value?.known === true &&
    (typeof value.value === "boolean" || typeof value.value === "number" && Number.isFinite(value.value))
    ? { known: true, value: value.value } : { known: false };
  function create(operation) {
    if (!label(operation)) throw new TypeError("Invalid diagnostic operation.");
    const state = globalThis.AkuDiagnosticState.create();
    let sequence = 0, elapsedObservation = { known: false };
    function settlement(field, value, condition) {
      if (!label(value) || !label(condition)) throw new TypeError("Invalid diagnostic settlement.");
      state[field](value, condition);
    }
    return Object.freeze({
      advance(phase, elapsed) {
        if (!label(phase)) throw new TypeError("Invalid diagnostic phase.");
        state.advance(phase);
        sequence = Math.min(Number.MAX_SAFE_INTEGER, sequence + 1);
        elapsedObservation = observed(elapsed);
      },
      completed(phase) { if (label(phase)) state.completed(phase); },
      fail(phase, condition) {
        if (!label(phase) || !label(condition)) throw new TypeError("Invalid diagnostic cause.");
        state.fail(phase, condition);
      },
      cleanup: (state, condition = "none") => settlement("cleanup", state, condition),
      delivery: (state, condition = "none") => settlement("delivery", state, condition),
      disposition(value) { if (label(value)) state.disposition(value); },
      incomplete() { state.incomplete(); },
      snapshot() {
        const value = state.snapshot();
        return { location: { operation, phase: value.phase }, completed: value.completed, sequence,
          elapsed: { ...elapsedObservation }, cause: value.cause ? {
            location: { operation, phase: value.cause.phase }, condition: value.cause.condition } : null,
          cleanup: value.cleanup, delivery: value.delivery, disposition: value.disposition, complete: value.complete };
      },
    });
  }
  globalThis.AkuDiagnosticRecorder = Object.freeze({ create, observed });
})();
