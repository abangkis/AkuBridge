import test from "node:test";
import assert from "node:assert/strict";
import {
  TAB_COMPLETE_OR_SOURCE_READY,
  navigationReadinessOutcome,
} from "../navigation-readiness-policy.js";

const validReadiness = Object.freeze({
  source: "instagram",
  runtimeRevision: "source-adapters-v99",
  adapterVersion: "instagram-dom-v4",
  state: "feed_ready",
  feedRootPresent: true,
  visibleSelectorCandidateCount: 2,
});

function outcome(overrides = {}) {
  return navigationReadinessOutcome({
    mode: TAB_COMPLETE_OR_SOURCE_READY,
    tabStatus: "loading",
    readiness: validReadiness,
    expectedSource: "instagram",
    expectedAdapterVersion: "instagram-dom-v4",
    expectedRuntimeRevision: "source-adapters-v99",
    canonicalFeed: true,
    ...overrides,
  });
}

test("verified Instagram feed readiness may finish a stalled navigation wait", () => {
  assert.deepEqual(outcome(), { ready: true, reason: "source_ready" });
});

test("Chrome tab completion remains authoritative without a source fallback", () => {
  assert.deepEqual(outcome({
    mode: undefined,
    tabStatus: "complete",
    readiness: null,
    canonicalFeed: false,
  }), { ready: true, reason: "tab_complete" });
});

test("navigation readiness rejects incomplete or untrusted source evidence", () => {
  for (const overrides of [
    { mode: undefined },
    { canonicalFeed: false },
    { readiness: { ...validReadiness, source: "x" } },
    { readiness: { ...validReadiness, runtimeRevision: "stale-runtime" } },
    { readiness: { ...validReadiness, adapterVersion: "instagram-dom-v0" } },
    { readiness: { ...validReadiness, state: "feed_empty" } },
    { readiness: { ...validReadiness, state: "loading" } },
    { readiness: { ...validReadiness, feedRootPresent: false } },
    { readiness: { ...validReadiness, visibleSelectorCandidateCount: 0 } },
  ]) {
    assert.equal(outcome(overrides).ready, false);
  }
});
