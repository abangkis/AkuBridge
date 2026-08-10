const runtimeRevision = "structured-media-collection-runtime-v1";

export async function collectStructuredMediaWithinBudget({
  collector,
  tabId,
  budgetMs = 250,
  now = () => performance.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  const boundedBudgetMs = clampInteger(budgetMs, 50, 1_000, 250);
  const startedAtMs = now();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = schedule(() => resolve({ status: "timeout", value: null }), boundedBudgetMs);
  });
  const collection = Promise.resolve()
    .then(() => typeof collector === "function" ? collector(tabId) : null)
    .then(
      (value) => ({ status: value ? "completed" : "unavailable", value }),
      (error) => ({
        status: "unavailable",
        value: {
          candidates: [],
          diagnostics: { reason: String(error?.message ?? error).slice(0, 300) },
        },
      }),
    );
  const outcome = await Promise.race([collection, timeout]);
  if (timer !== null) cancel(timer);
  const elapsedMs = Math.max(0, Math.round((now() - startedAtMs) * 10) / 10);
  const base = outcome.value && typeof outcome.value === "object" ? outcome.value : {};
  return Object.freeze({
    ...base,
    candidates: Array.isArray(base.candidates) ? base.candidates : [],
    diagnostics: Object.freeze({
      ...(base.diagnostics && typeof base.diagnostics === "object" ? base.diagnostics : {}),
      collection: Object.freeze({
        runtimeRevision,
        mode: "parallel_deferred",
        status: outcome.status,
        budgetMs: boundedBudgetMs,
        elapsedMs,
      }),
    }),
  });
}

export async function captureWithParallelStructuredMedia({ capture, collect, deliver } = {}) {
  const collectionPromise = Promise.resolve().then(() => collect?.());
  const capturePromise = Promise.resolve().then(() => capture?.());
  const deliveryPromise = collectionPromise.then(async (evidence) => {
    try {
      return await deliver?.(evidence) === true;
    } catch {
      return false;
    }
  });
  const [response, delivered] = await Promise.all([capturePromise, deliveryPromise]);
  return Object.freeze({ response, delivered });
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

export { runtimeRevision };
