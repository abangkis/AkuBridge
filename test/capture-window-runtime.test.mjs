import test from "node:test";
import assert from "node:assert/strict";
import {
  createManagedCaptureWindowRuntime,
  normalizeManagedCaptureState,
} from "../capture-window-runtime.js";

test("managed capture creates a non-focused window and preserves the working tab", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");

  assert.equal(prepared.opened, true);
  assert.equal(prepared.tab.url, "https://x.com/home");
  assert.equal(chrome.createdWindowOptions.focused, false);
  assert.deepEqual(await prepared.verifyFocus(), {
    changed: false,
    restored: false,
    preserved: true,
  });
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
});

test("managed capture refuses creation when missing-tab policy forbids it", async () => {
  const chrome = fakeChrome();
  await assert.rejects(
    createManagedCaptureWindowRuntime(chrome).prepare("linkedin", { openIfMissing: false }),
    (error) => error.code === "visible_recovery_required" &&
      error.stage === "capture_visibility",
  );
});

test("managed capture state accepts only known numeric bindings", () => {
  assert.deepEqual(normalizeManagedCaptureState({
    windowId: 8,
    tabs: { x: 9, linkedin: "10", other: 11 },
  }), { windowId: 8, tabs: { x: 9 } });
});

function fakeChrome() {
  const storage = {};
  const windows = new Map([[1, {
    id: 1,
    tabs: [{ id: 11, windowId: 1, active: true, url: "http://127.0.0.1:47821/" }],
  }]]);
  const tabs = new Map([[11, windows.get(1).tabs[0]]]);
  const activeByWindow = new Map([[1, 11]]);
  const state = {
    focusedWindowId: 1,
    activeByWindow,
    createdWindowOptions: null,
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
    } },
    windows: {
      async getLastFocused() { return { id: state.focusedWindowId }; },
      async get(id, { populate } = {}) {
        const window = windows.get(id);
        if (!window) throw new Error("No window");
        return populate ? { ...window, tabs: [...window.tabs] } : { id };
      },
      async create(options) {
        state.createdWindowOptions = options;
        const tab = { id: 21, windowId: 2, active: true, url: options.url };
        tabs.set(tab.id, tab);
        activeByWindow.set(2, tab.id);
        windows.set(2, { id: 2, tabs: [tab] });
        return { id: 2, tabs: [tab] };
      },
      async update(id, options) {
        if (options.focused) state.focusedWindowId = id;
        return { id };
      },
    },
    tabs: {
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab");
        return { ...tab, active: activeByWindow.get(tab.windowId) === id };
      },
      async query({ active, windowId }) {
        if (!active) return [];
        const id = activeByWindow.get(windowId);
        return id ? [{ ...tabs.get(id), active: true }] : [];
      },
      async update(id, options) {
        const tab = tabs.get(id);
        if (options.active) activeByWindow.set(tab.windowId, id);
        return { ...tab, active: options.active === true };
      },
      async create() { throw new Error("not used"); },
    },
  };
  return state;
}

