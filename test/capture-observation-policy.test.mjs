import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyCaptureDiagnostics,
  observationEvidenceBlockCount,
} from "../capture-observation-policy.js";

test("observation evidence count is summed across bounded snapshots", () => {
  assert.equal(observationEvidenceBlockCount({
    snapshots: [{ blocks: [{ evidenceKey: "one" }] }, { blocks: [] }, { blocks: [{ evidenceKey: "two" }] }],
  }), 2);
  assert.equal(observationEvidenceBlockCount({ snapshots: [{ blocks: [] }] }), 0);
});

test("empty capture diagnostics preserve selector and readiness evidence without post content", () => {
  const details = emptyCaptureDiagnostics({
    source: "facebook",
    snapshots: [{
      adapterVersion: "facebook-dom-v8",
      selectorStrategy: "div[aria-posinset]",
      selectorCounts: { "div[aria-posinset]": 2 },
      selectorCandidateCount: 2,
      visibleContainerCount: 0,
      blocks: [],
    }],
    coverage: {
      adapterHealth: { state: "degraded", selectorCounts: { "div[aria-posinset]": 2 } },
      sourceReadinessState: "feed_not_visible",
      sourceReadinessWaitMs: 25000,
      captureVisibilityMode: "managed_window",
      snapshotCount: 1,
      observedBlockCount: 0,
    },
  });
  assert.deepEqual(details, {
    source: "facebook",
    adapterVersion: "facebook-dom-v8",
    adapterState: "degraded",
    selectorStrategy: "div[aria-posinset]",
    selectorCounts: { "div[aria-posinset]": 2 },
    selectorCandidateCount: 2,
    visibleSelectorCandidateCount: 0,
    readinessState: "feed_not_visible",
    readinessWaitMs: 25000,
    captureVisibilityMode: "managed_window",
    captureSurfaceReason: null,
    snapshotCount: 1,
    observedBlockCount: 0,
  });
});
