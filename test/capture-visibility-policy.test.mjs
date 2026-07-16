import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCaptureVisibilityPolicy,
  planCaptureVisibility,
  requiresSameWindowRecovery,
} from "../capture-visibility-policy.js";

test("Quiet catch-up requires the managed window without visible fallback", () => {
  assert.deepEqual(planCaptureVisibility({ policy: "quiet", mode: "catch_up" }), {
    policy: "quiet",
    initialMode: "managed_window",
    allowSameWindowFallback: false,
  });
});

test("Adaptive catch-up authorizes same-window recovery only as fallback", () => {
  assert.deepEqual(planCaptureVisibility({
    policy: "adaptive_fidelity",
    mode: "catch_up",
  }), {
    policy: "adaptive_fidelity",
    initialMode: "managed_window",
    allowSameWindowFallback: true,
  });
});

test("item media recapture stays inside the managed capture surface", () => {
  assert.deepEqual(planCaptureVisibility({ policy: "quiet", mode: "recapture_media" }), {
    policy: "quiet",
    initialMode: "managed_window",
    allowSameWindowFallback: false,
  });
  assert.equal(planCaptureVisibility({
    policy: "adaptive_fidelity",
    mode: "recapture_media",
  }).allowSameWindowFallback, false);
});

test("unknown visibility policies fail closed to Quiet", () => {
  assert.equal(normalizeCaptureVisibilityPolicy("surprise_me"), "quiet");
});

test("Adaptive escalates only when managed visual hydration remains incomplete", () => {
  const adaptive = planCaptureVisibility({ policy: "adaptive_fidelity", mode: "catch_up" });
  const quiet = planCaptureVisibility({ policy: "quiet", mode: "catch_up" });
  const incomplete = { visualHydrationRequired: true, visualHydrationReady: false };
  assert.equal(requiresSameWindowRecovery(adaptive, incomplete), true);
  assert.equal(requiresSameWindowRecovery(quiet, incomplete), false);
  assert.equal(requiresSameWindowRecovery(adaptive, {
    visualHydrationRequired: true,
    visualHydrationReady: true,
  }), false);
});
