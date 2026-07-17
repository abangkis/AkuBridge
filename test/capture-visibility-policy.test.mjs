import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCaptureVisibilityPolicy,
  planCaptureVisibility,
} from "../capture-visibility-policy.js";

test("Quiet catch-up requires the managed window without visible fallback", () => {
  assert.deepEqual(planCaptureVisibility({ policy: "quiet", mode: "catch_up" }), {
    policy: "quiet",
    initialMode: "managed_window",
    allowSameWindowFallback: false,
  });
});

test("Adaptive catch-up uses the ordinary canonical source-tab path directly", () => {
  assert.deepEqual(planCaptureVisibility({
    policy: "adaptive_fidelity",
    mode: "catch_up",
  }), {
    policy: "adaptive_fidelity",
    initialMode: "same_window",
    allowSameWindowFallback: false,
  });
});

test("item media recapture stays inside the managed capture surface", () => {
  assert.deepEqual(planCaptureVisibility({ policy: "quiet", mode: "recapture_media" }), {
    policy: "quiet",
    initialMode: "managed_window",
    allowSameWindowFallback: false,
    foregroundAuthorized: false,
  });
  assert.equal(planCaptureVisibility({
    policy: "adaptive_fidelity",
    mode: "recapture_media",
  }).allowSameWindowFallback, false);
});

test("foreground media recapture requires an explicit per-job authorization", () => {
  const foreground = planCaptureVisibility({
    policy: "quiet",
    mode: "recapture_media",
    foregroundAuthorized: true,
  });
  assert.equal(foreground.initialMode, "managed_window");
  assert.equal(foreground.allowSameWindowFallback, false);
  assert.equal(foreground.foregroundAuthorized, true);
});

test("unknown visibility policies fail closed to Quiet", () => {
  assert.equal(normalizeCaptureVisibilityPolicy("surprise_me"), "quiet");
});
