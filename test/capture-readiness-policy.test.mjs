import test from "node:test";
import assert from "node:assert/strict";
import { captureRequiresVisualHydration } from "../capture-readiness-policy.js";

test("initial feed capture retains visual hydration", () => {
  assert.equal(captureRequiresVisualHydration({ source: "x", acquisitionRound: 1 }), true);
  assert.equal(captureRequiresVisualHydration({ source: "linkedin", acquisitionRound: 1 }), true);
});

test("X continuation uses feed readiness without repeating visual hydration", () => {
  assert.equal(captureRequiresVisualHydration({ source: "x", acquisitionRound: 2 }), false);
  assert.equal(captureRequiresVisualHydration({ source: "x", acquisitionRound: 3 }), true);
  assert.equal(captureRequiresVisualHydration({ source: "linkedin", acquisitionRound: 2 }), true);
});

test("native-post recapture preserves its existing visibility behavior", () => {
  const targetUrl = "https://x.com/example/status/123";
  assert.equal(captureRequiresVisualHydration({
    source: "x",
    acquisitionRound: 2,
    targetUrl,
    foregroundAuthorized: false,
  }), false);
  assert.equal(captureRequiresVisualHydration({
    source: "x",
    acquisitionRound: 2,
    targetUrl,
    foregroundAuthorized: true,
  }), true);
});
