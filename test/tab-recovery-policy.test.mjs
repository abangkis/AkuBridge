import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmptyCaptureError,
  isStaleTabError,
  shouldRetrySourceTab,
} from "../tab-recovery-policy.js";

test("initial acquisition retries exactly once after a stale tab reference", () => {
  assert.equal(isStaleTabError(new Error("No tab with id: 42")), true);
  assert.equal(shouldRetrySourceTab({
    error: new Error("No tab with id: 42"),
    acquisitionRound: 1,
    attempt: 0,
  }), true);
  assert.equal(shouldRetrySourceTab({
    error: new Error("No tab with id: 43"),
    acquisitionRound: 1,
    attempt: 1,
  }), false);
});

test("follow-up and non-tab failures never rebind to another source tab", () => {
  assert.equal(shouldRetrySourceTab({
    error: new Error("No tab with id: 42"),
    acquisitionRound: 2,
    attempt: 0,
  }), false);
  assert.equal(shouldRetrySourceTab({
    error: new Error("LinkedIn source readiness failed: selector_mismatch"),
    acquisitionRound: 1,
    attempt: 0,
  }), false);
});

test("an initial empty capture retries only for a managed source with an explicit policy", () => {
  const error = { code: "capture_empty", message: "no usable evidence" };
  assert.equal(isEmptyCaptureError(error), true);
  assert.equal(shouldRetrySourceTab({
    error,
    acquisitionRound: 1,
    attempt: 0,
    ownership: "managed",
    emptyObservationRecovery: "reload_managed_once",
  }), true);
  assert.equal(shouldRetrySourceTab({
    error,
    acquisitionRound: 1,
    attempt: 0,
    ownership: "shared",
    emptyObservationRecovery: "reload_managed_once",
  }), false);
  assert.equal(shouldRetrySourceTab({
    error,
    acquisitionRound: 1,
    attempt: 1,
    ownership: "managed",
    emptyObservationRecovery: "reload_managed_once",
  }), false);
});

test("Facebook empty capture retries only while its managed feed is not stably ready", () => {
  const policy = "reload_managed_once_if_unready";
  assert.equal(shouldRetrySourceTab({
    error: {
      code: "capture_empty",
      details: {
        readinessState: "feed_ready",
        selectorCandidateCount: 2,
        visibleSelectorCandidateCount: 1,
      },
    },
    acquisitionRound: 1,
    attempt: 0,
    ownership: "managed",
    emptyObservationRecovery: policy,
  }), false);
  assert.equal(shouldRetrySourceTab({
    error: {
      code: "capture_empty",
      details: {
        readinessState: "feed_empty",
        selectorCandidateCount: 0,
        visibleSelectorCandidateCount: 0,
      },
    },
    acquisitionRound: 1,
    attempt: 0,
    ownership: "managed",
    emptyObservationRecovery: policy,
  }), false);
  assert.equal(shouldRetrySourceTab({
    error: {
      code: "capture_empty",
      details: {
        readinessState: "feed_ready",
        selectorCandidateCount: 2,
        visibleSelectorCandidateCount: 0,
      },
    },
    acquisitionRound: 1,
    attempt: 0,
    ownership: "managed",
    emptyObservationRecovery: policy,
  }), true);
  assert.equal(shouldRetrySourceTab({
    error: {
      code: "capture_empty",
      details: {
        readinessState: "feed_not_visible",
        selectorCandidateCount: 0,
        visibleSelectorCandidateCount: 0,
      },
    },
    acquisitionRound: 1,
    attempt: 0,
    ownership: "managed",
    emptyObservationRecovery: policy,
  }), true);
});
