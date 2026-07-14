import test from "node:test";
import assert from "node:assert/strict";
import { recoverSourceFreshness } from "../source-freshness-recovery.js";

test("an active X tab reveals an already-visible pending-content control", async () => {
  const result = await recoverSourceFreshness({
    source: "x",
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: true,
    probe: sequence([probe("x", { pending: true, label: "Show 70 posts" })]),
    activate: async () => false,
    reveal: async () => ({
      evidence: "feed_fingerprint_changed",
      label: "Show 70 posts",
      preActionScrollY: 420,
    }),
  });
  assert.equal(result.outcome, "pending_content_revealed");
  assert.equal(result.pendingContentAction, "activated");
  assert.equal(result.feedMutation, true);
  assert.equal(result.preActionScrollY, 420);
});

test("a stale X tab wakes before revealing content returned by the server", async () => {
  const clock = fakeClock();
  let activated = false;
  const result = await recoverSourceFreshness({
    source: "x",
    backgroundAtDispatch: true,
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: true,
    probe: sequence([
      probe("x", { visibility: "hidden", fingerprint: "old" }),
      probe("x", { visibility: "visible", fingerprint: "old", pending: true, label: "Show 12 posts" }),
    ]),
    activate: async () => { activated = true; return true; },
    reveal: async () => ({
      evidence: "feed_fingerprint_changed",
      label: "Show 12 posts",
      preActionScrollY: 0,
    }),
    ...clock,
  });
  assert.equal(activated, true);
  assert.equal(result.wakeAttempted, true);
  assert.equal(result.activated, true);
  assert.equal(result.outcome, "pending_content_revealed");
});

test("a stale LinkedIn tab accepts an automatically changed feed after wake", async () => {
  const clock = fakeClock();
  const result = await recoverSourceFreshness({
    source: "linkedin",
    backgroundAtDispatch: true,
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: true,
    probe: sequence([
      probe("linkedin", { visibility: "hidden", fingerprint: "old" }),
      probe("linkedin", { visibility: "visible", fingerprint: "new" }),
    ]),
    activate: async () => true,
    reveal: async () => { throw new Error("reveal should not be used"); },
    ...clock,
  });
  assert.equal(result.outcome, "feed_changed_after_wake");
  assert.equal(result.verification, "feed_change");
  assert.equal(result.feedMutation, false);
});

test("adapter wake contract supplies a bounded no-change terminal outcome", async () => {
  const clock = fakeClock();
  const stable = probe("linkedin", { visibility: "visible", fingerprint: "same" });
  const result = await recoverSourceFreshness({
    source: "linkedin",
    backgroundAtDispatch: true,
    probe: sequence([probe("linkedin", { visibility: "hidden", fingerprint: "same" }), stable]),
    activate: async () => true,
    reveal: async () => null,
    ...clock,
  });
  assert.equal(result.outcome, "adapter_wake_settled");
  assert.equal(result.verification, "adapter_wake_contract");
  assert.ok(result.probeCount > 1);
});

test("an unfocused Chrome window may remain document-hidden after valid tab activation", async () => {
  const clock = fakeClock();
  const hidden = probe("x", { visibility: "hidden", fingerprint: "same" });
  const result = await recoverSourceFreshness({
    source: "x",
    backgroundAtDispatch: true,
    probe: sequence([hidden]),
    activate: async () => true,
    reveal: async () => null,
    ...clock,
  });
  assert.equal(result.outcome, "adapter_wake_settled");
  assert.equal(result.documentVisibleObserved, false);
  assert.equal(result.activated, true);
});

test("pending content without reveal authority fails as freshness unavailable", async () => {
  await assert.rejects(
    recoverSourceFreshness({
      source: "linkedin",
      pendingContentPolicy: "detect_only",
      sameTabMutationAllowed: false,
      probe: sequence([probe("linkedin", { pending: true, label: "New posts" })]),
      activate: async () => false,
      reveal: async () => null,
    }),
    (error) => error.code === "freshness_unavailable" && error.stage === "source_freshness",
  );
});

test("follow-up acquisition preserves its prior frontier without wake or reveal", async () => {
  let activated = false;
  const result = await recoverSourceFreshness({
    source: "x",
    acquisitionRound: 2,
    backgroundAtDispatch: true,
    probe: sequence([probe("x", { visibility: "hidden" })]),
    activate: async () => { activated = true; return true; },
    reveal: async () => null,
  });
  assert.equal(activated, false);
  assert.equal(result.outcome, "follow_up_preserved");
  assert.equal(result.wakeAttempted, false);
});

function probe(source, {
  visibility = "visible",
  fingerprint = "feed-a",
  pending = false,
  label = "",
} = {}) {
  return {
    source,
    strategy: {
      version: `${source}-freshness-v1`,
      wakeWhenBackground: true,
      settledWakeIsCurrent: true,
      wakeObservationMs: 500,
      probeIntervalMs: 100,
    },
    documentVisibility: visibility,
    pendingContentDetected: pending,
    pendingContentLabel: label,
    feedFingerprint: fingerprint,
    scrollY: 0,
  };
}

function sequence(values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    delay: async (milliseconds) => { value += milliseconds; },
  };
}
