const SOURCE_SESSION_STATES = new Set([
  "ready",
  "login_required",
  "not_observed",
  "loading",
  "unavailable",
  "unknown",
]);

export const SOURCE_SESSION_MAX_TABS = 3;
export const SOURCE_SESSION_STATE_VALUES = Object.freeze([...SOURCE_SESSION_STATES]);

export function sourceSessionStateFromReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") return "unknown";
  if (readiness.state === "login_required") return "login_required";
  if (readiness.state === "source_unavailable" || readiness.availability?.state === "source_unavailable") {
    return "unavailable";
  }
  if (readiness.state === "loading" || readiness.loadingIndicator === true) return "loading";
  if (["feed_ready", "feed_empty", "feed_not_visible"].includes(readiness.state)) return "ready";
  if (readiness.state === "wrong_page") return "not_observed";
  return "unknown";
}

export function createSourceSessionObservation({
  source,
  state = "unknown",
  observedAt = new Date().toISOString(),
  tabCount = 0,
  detail = null,
} = {}) {
  const normalizedState = SOURCE_SESSION_STATES.has(state) ? state : "unknown";
  const boundedTabCount = Number.isFinite(Number(tabCount))
    ? Math.max(0, Math.min(SOURCE_SESSION_MAX_TABS, Math.trunc(Number(tabCount))))
    : 0;
  return Object.freeze({
    source: String(source ?? "").trim().slice(0, 40),
    state: normalizedState,
    observedAt: String(observedAt || new Date().toISOString()).slice(0, 40),
    tabCount: boundedTabCount,
    ...(detail ? { detail: String(detail).trim().slice(0, 160) } : {}),
  });
}

export function sourceSessionStateForTabs(tabs = []) {
  if (!Array.isArray(tabs) || tabs.length === 0) return "not_observed";
  const states = tabs.map((entry) => sourceSessionStateFromReadiness(entry?.readiness));
  if (states.includes("ready")) return "ready";
  if (states.includes("login_required")) return "login_required";
  if (states.includes("unavailable")) return "unavailable";
  if (states.includes("loading")) return "loading";
  return "unknown";
}
