import test from "node:test";
import assert from "node:assert/strict";
import { inspectCaptureSurface } from "../capture-surface-telemetry.js";

test("capture surface telemetry records visibility-relevant state without identifiers", async () => {
  const telemetry = await inspectCaptureSurface({
    tabs: { get: async () => ({
      id: 42,
      windowId: 7,
      active: true,
      discarded: false,
      status: "complete",
    }) },
    windows: { get: async () => ({
      id: 7,
      state: "normal",
      type: "normal",
      focused: false,
      width: 960,
      height: 900,
    }) },
  }, 42);

  assert.deepEqual(telemetry, {
    available: true,
    reason: null,
    windowState: "normal",
    windowType: "normal",
    windowFocused: false,
    windowWidth: 960,
    windowHeight: 900,
    tabActive: true,
    tabDiscarded: false,
    tabStatus: "complete",
  });
  assert.equal("windowId" in telemetry, false);
  assert.equal("tabId" in telemetry, false);
});

test("capture surface telemetry fails closed when Chrome no longer exposes the tab", async () => {
  const telemetry = await inspectCaptureSurface({
    tabs: { get: async () => { throw new Error("gone"); } },
    windows: { get: async () => { throw new Error("unused"); } },
  }, 42);

  assert.equal(telemetry.available, false);
  assert.equal(telemetry.reason, "tab_unavailable");
  assert.equal(telemetry.windowState, "unknown");
});
