(() => {
  if (globalThis.AkuDiagnosticRecorder) return;
  const label = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
  const observed = value => value?.known === true &&
    (typeof value.value === "boolean" || typeof value.value === "number" && Number.isFinite(value.value))
    ? { known: true, value: value.value } : { known: false };
  function create(operation) {
    if (!label(operation)) throw new TypeError("Invalid diagnostic operation.");
    const value = { location: { operation, phase: "none" }, completed: "none", sequence: 0,
      elapsed: { known: false }, cause: null, cleanup: { state: "not_started", condition: "none" },
      delivery: { state: "pending", condition: "none" }, disposition: "not_started", complete: true };
    function settlement(field, state, condition) {
      if (!label(state) || !label(condition)) throw new TypeError("Invalid diagnostic settlement.");
      value[field] = { state, condition };
    }
    return Object.freeze({
      advance(phase, elapsed) {
        if (!label(phase)) throw new TypeError("Invalid diagnostic phase.");
        value.location.phase = phase;
        value.sequence = Math.min(Number.MAX_SAFE_INTEGER, value.sequence + 1);
        value.elapsed = observed(elapsed);
      },
      completed(phase) { if (label(phase)) value.completed = phase; },
      fail(phase, condition) {
        if (!label(phase) || !label(condition)) throw new TypeError("Invalid diagnostic cause.");
        value.cause ??= { location: { operation, phase }, condition };
      },
      cleanup: (state, condition = "none") => settlement("cleanup", state, condition),
      delivery: (state, condition = "none") => settlement("delivery", state, condition),
      disposition(state) { if (label(state)) value.disposition = state; },
      incomplete() { value.complete = false; },
      snapshot() {
        return { ...value, location: { ...value.location }, elapsed: { ...value.elapsed },
          cleanup: { ...value.cleanup }, delivery: { ...value.delivery },
          cause: value.cause ? { ...value.cause, location: { ...value.cause.location } } : null };
      },
    });
  }
  globalThis.AkuDiagnosticRecorder = Object.freeze({ create, observed });
})();
