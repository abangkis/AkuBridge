import { AkuBridgeError } from "./bridge-runtime-policy.js";

const TERMINAL_READY = new Set([
  "active_feed_ready",
  "new_tab_ready",
  "feed_changed_after_wake",
  "pending_content_revealed",
  "adapter_wake_settled",
  "follow_up_preserved",
]);

/**
 * Generic source-freshness state machine.
 *
 * Platform knowledge is supplied by the content-side adapter probe. This
 * module owns only bounded activation, polling, reveal authorization, proof
 * classification, and the terminal result contract.
 */
export async function recoverSourceFreshness({
  source,
  acquisitionRound = 1,
  backgroundAtDispatch = false,
  opened = false,
  activatedBeforeRecovery = false,
  pendingContentPolicy = "detect_only",
  sameTabMutationAllowed = false,
  activate,
  probe,
  reveal,
  delay = defaultDelay,
  now = Date.now,
}) {
  const startedAt = now();
  const initial = assertProbe(await probe(), source);
  const strategy = normalizeStrategy(initial.strategy);
  const base = {
    policyVersion: "source-freshness-recovery-v1",
    adapterFreshnessVersion: strategy.version,
    source,
    backgroundAtDispatch: backgroundAtDispatch === true,
    opened: opened === true,
    wakeAttempted: false,
    activated: activatedBeforeRecovery === true,
    documentVisibleObserved: initial.documentVisibility === "visible",
    probeCount: 1,
    pendingContentDetected: initial.pendingContentDetected,
    pendingContentLabel: initial.pendingContentLabel,
    pendingContentAction: initial.pendingContentDetected ? "not_activated" : "not_detected",
    feedChanged: false,
    feedMutation: false,
    evidence: null,
    verification: null,
    waitMs: 0,
    preActionScrollY: initial.scrollY,
  };

  if (acquisitionRound > 1) {
    return finish(base, startedAt, {
      status: "ready",
      outcome: "follow_up_preserved",
      verification: "frontier_contract",
      evidence: "follow_up_no_freshness_mutation",
    }, now);
  }

  if (!backgroundAtDispatch && !opened) {
    if (initial.pendingContentDetected) {
      return revealPending({
        source,
        state: base,
        pendingContentPolicy,
        sameTabMutationAllowed,
        reveal,
        startedAt,
        now,
      });
    }
    return finish(base, startedAt, {
      status: "ready",
      outcome: "active_feed_ready",
      verification: "active_dispatch",
      evidence: "active_at_dispatch",
    }, now);
  }

  if (!strategy.wakeWhenBackground) {
    throw freshnessUnavailable(source, "The adapter does not authorize background-tab wake recovery.", base);
  }

  base.wakeAttempted = true;
  base.activated = await activate() === true || base.activated;
  const wakeStartedAt = now();
  const wakeDeadline = wakeStartedAt + strategy.wakeObservationMs;
  let current = initial;
  while (now() < wakeDeadline) {
    await delay(Math.min(strategy.probeIntervalMs, wakeDeadline - now()));
    current = assertProbe(await probe(), source);
    base.probeCount += 1;
    base.pendingContentDetected = current.pendingContentDetected;
    base.pendingContentLabel = current.pendingContentLabel;
    base.pendingContentAction = current.pendingContentDetected ? "not_activated" : "not_detected";
    base.documentVisibleObserved ||= current.documentVisibility === "visible";
    if (current.pendingContentDetected) break;
    if (feedChanged(initial, current)) {
      base.feedChanged = true;
      break;
    }
  }

  if (current.pendingContentDetected) {
    return revealPending({
      source,
      state: base,
      pendingContentPolicy,
      sameTabMutationAllowed,
      reveal,
      startedAt,
      now,
    });
  }
  if (base.feedChanged) {
    return finish(base, startedAt, {
      status: "ready",
      outcome: "feed_changed_after_wake",
      verification: "feed_change",
      evidence: "feed_fingerprint_changed_after_wake",
    }, now);
  }
  if (!strategy.settledWakeIsCurrent) {
    throw freshnessUnavailable(
      source,
      "The adapter could not verify current content after bounded wake recovery.",
      base,
    );
  }
  return finish(base, startedAt, {
    status: "ready",
    outcome: opened ? "new_tab_ready" : "adapter_wake_settled",
    verification: opened ? "new_tab_load" : "adapter_wake_contract",
    evidence: opened ? "new_tab_loaded_and_woken" : "adapter_wake_window_settled",
  }, now);
}

async function revealPending({
  source,
  state,
  pendingContentPolicy,
  sameTabMutationAllowed,
  reveal,
  startedAt,
  now,
}) {
  if (pendingContentPolicy !== "reveal_if_present" || sameTabMutationAllowed !== true) {
    throw freshnessUnavailable(
      source,
      "Fresh content is pending but this acquisition is not authorized to reveal it.",
      state,
    );
  }
  let result;
  try {
    result = await reveal();
  } catch (error) {
    throw freshnessUnavailable(
      source,
      `The pending-content reveal did not produce a changed feed: ${String(error?.message ?? error)}`,
      state,
    );
  }
  if (result?.evidence !== "feed_fingerprint_changed") {
    throw freshnessUnavailable(source, "The reveal returned no accepted feed-change proof.", state);
  }
  return finish(state, startedAt, {
    status: "ready",
    outcome: "pending_content_revealed",
    verification: "feed_change",
    evidence: result.evidence,
    pendingContentDetected: true,
    pendingContentLabel: result.label || state.pendingContentLabel,
    pendingContentAction: "activated",
    feedChanged: true,
    feedMutation: true,
    preActionScrollY: Number.isFinite(result.preActionScrollY)
      ? Math.trunc(result.preActionScrollY)
      : state.preActionScrollY,
  }, now);
}

function assertProbe(value, source) {
  if (!value || value.source !== source || typeof value.feedFingerprint !== "string") {
    throw freshnessUnavailable(source, "The adapter returned an invalid freshness probe.");
  }
  return value;
}

function normalizeStrategy(value = {}) {
  return {
    version: typeof value.version === "string" && value.version ? value.version : "unknown",
    wakeWhenBackground: value.wakeWhenBackground === true,
    settledWakeIsCurrent: value.settledWakeIsCurrent === true,
    wakeObservationMs: clampInteger(value.wakeObservationMs, 500, 8_000, 3_000),
    probeIntervalMs: clampInteger(value.probeIntervalMs, 100, 1_000, 250),
  };
}

function feedChanged(before, after) {
  return before.feedFingerprint.length > 0 &&
    after.feedFingerprint.length > 0 &&
    before.feedFingerprint !== after.feedFingerprint;
}

function finish(base, startedAt, values, now) {
  const result = Object.freeze({
    ...base,
    ...values,
    waitMs: Math.max(0, now() - startedAt),
  });
  if (result.status !== "ready" || !TERMINAL_READY.has(result.outcome)) {
    throw new Error("Source freshness recovery produced an invalid terminal state.");
  }
  return result;
}

function freshnessUnavailable(source, message, state = {}) {
  return new AkuBridgeError(
    "freshness_unavailable",
    "source_freshness",
    `${source} freshness unavailable: ${message}`,
    {
      policyVersion: "source-freshness-recovery-v1",
      wakeAttempted: state.wakeAttempted === true,
      activated: state.activated === true,
      pendingContentDetected: state.pendingContentDetected === true,
      pendingContentAction: state.pendingContentAction ?? "not_detected",
      probeCount: state.probeCount ?? 0,
    },
  );
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
