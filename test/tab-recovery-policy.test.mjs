import test from "node:test";
import assert from "node:assert/strict";
import { isStaleTabError, shouldRetrySourceTab } from "../tab-recovery-policy.js";

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
