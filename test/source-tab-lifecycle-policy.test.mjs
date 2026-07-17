import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSourceTabLifecycle,
  shouldCloseOpenedSourceTab,
} from "../source-tab-lifecycle-policy.js";

test("source tabs are preserved unless an opened managed tab explicitly requests closure", () => {
  assert.deepEqual(normalizeSourceTabLifecycle(), {
    ownership: "shared",
    openedTabDisposition: "preserve",
  });
  assert.equal(shouldCloseOpenedSourceTab({
    opened: true,
    lifecycle: { ownership: "managed", openedTabDisposition: "close_after_capture" },
    captureCompleted: true,
  }), true);
  assert.equal(shouldCloseOpenedSourceTab({
    opened: false,
    lifecycle: { openedTabDisposition: "close_after_capture" },
    captureCompleted: true,
  }), false);
  assert.equal(shouldCloseOpenedSourceTab({
    opened: true,
    lifecycle: { openedTabDisposition: "close_after_capture" },
    captureCompleted: false,
  }), false);
  assert.deepEqual(normalizeSourceTabLifecycle({
    ownership: "managed",
    openedTabDisposition: "close_after_session",
  }), {
    ownership: "managed",
    openedTabDisposition: "close_after_session",
  });
  assert.equal(shouldCloseOpenedSourceTab({
    opened: true,
    lifecycle: { openedTabDisposition: "close_after_session" },
    captureCompleted: true,
  }), false);
});
