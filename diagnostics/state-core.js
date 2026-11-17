// Canonical shared state mechanism. The Node worker carries identical runtime bytes.
// Consumers own validation, clocks, budgets, sequence and delivery policy.
(() => {
  if (globalThis.AkuDiagnosticState) return;
  function create() {
    const value = { phase: "none", completed: "none", cause: null,
      cleanup: { state: "not_started", condition: "none" },
      delivery: { state: "pending", condition: "none" }, disposition: "not_started", complete: true };
    return Object.freeze({
      currentPhase: () => value.phase,
      advance(phase) { value.phase = phase; },
      completed(phase) { value.completed = phase; },
      fail(phase, condition) { value.cause ??= { phase, condition }; },
      cleanup(state, condition) { value.cleanup = { state, condition }; },
      delivery(state, condition) { value.delivery = { state, condition }; },
      disposition(state) { value.disposition = state; },
      incomplete() { value.complete = false; },
      snapshot() {
        return { ...value, cause: value.cause ? { ...value.cause } : null,
          cleanup: { ...value.cleanup }, delivery: { ...value.delivery } };
      },
    });
  }
  globalThis.AkuDiagnosticState = Object.freeze({ create });
})();
