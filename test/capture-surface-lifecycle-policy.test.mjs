import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceCaptureSurfaceReleasable,
} from "../capture-surface-lifecycle-policy.js";

test("capture surface stays leased while acquisition may request follow-up", () => {
  assert.equal(sourceCaptureSurfaceReleasable({
    status: "reasoning",
    stage: "acquisition_planning",
  }), false);
  assert.equal(sourceCaptureSurfaceReleasable({
    status: "waiting_for_bridge",
    stage: "follow_up_capture",
  }), false);
});

test("capture surface releases when candidate evaluation starts", () => {
  assert.equal(sourceCaptureSurfaceReleasable({
    status: "reasoning",
    stage: "candidate_evaluation",
  }), true);
});

test("terminal source outcomes remain releasable fallbacks", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(sourceCaptureSurfaceReleasable({ status, stage: status }), true);
  }
});
