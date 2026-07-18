import test from "node:test";
import assert from "node:assert/strict";
import {
  createManagedCaptureWindowRuntime,
  normalizeManagedCaptureState,
} from "../capture-window-runtime.js";

test("managed capture creates a non-focused window and preserves the working tab", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });

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

test("managed capture does not override a user's later tab choice", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });
  chrome.addTab(1, "https://example.com/new-work", 12);
  chrome.activeByWindow.set(1, 12);

  assert.deepEqual(await prepared.verifyFocus(), {
    changed: false,
    restored: false,
    preserved: true,
  });
  assert.equal(chrome.activeByWindow.get(1), 12);
});

test("managed capture restores focus only when its own window took focus", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });
  chrome.focusedWindowId = 2;

  assert.deepEqual(await prepared.verifyFocus(), {
    changed: true,
    restored: true,
    preserved: true,
  });
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
});

test("managed capture accepts a transient focus change that it successfully restores", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  chrome.focusManagedWindowOnTabActivation = true;

  const prepared = await runtime.prepare("linkedin", { leaseId: "session-1" });

  assert.equal(prepared.tab.url, "https://www.linkedin.com/feed/");
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.deepEqual(await runtime.release("session-1"), {
    released: true,
    mode: "owned_window_closed",
    closedTabs: 2,
    closedManagedTabs: 2,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
});

test("managed recapture activates its target inside the background window without foregrounding it", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-1",
  });
  chrome.focusManagedWindowOnTabActivation = true;

  const target = await prepared.openTargetTab("https://x.com/aku/status/123");

  assert.equal(target.url, "https://x.com/aku/status/123");
  assert.equal(target.active, true);
  assert.deepEqual(chrome.createdTabOptions.at(-1), {
    windowId: 2,
    url: "https://x.com/aku/status/123",
    active: false,
  });
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.equal(chrome.activeByWindow.get(2), target.id);
});

test("user-authorized foreground recapture is shown briefly and restores the working surface", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-foreground-1",
  });
  const target = await prepared.openTargetTab("https://x.com/aku/status/123");

  await prepared.showForeground();

  assert.equal(chrome.focusedWindowId, 2);
  assert.equal(chrome.activeByWindow.get(2), target.id);
  assert.deepEqual(await prepared.verifyFocus(), {
    changed: true,
    restored: true,
    preserved: true,
  });
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
});

test("managed recapture fails closed and removes its target when working focus cannot be restored", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-1",
  });
  chrome.focusManagedWindowOnTabActivation = true;
  chrome.failFocusRestore = true;

  await assert.rejects(
    prepared.openTargetTab("https://x.com/aku/status/123"),
    (error) => error.code === "visible_recovery_required" &&
      error.details?.reason === "managed_target_activation_took_focus",
  );
  assert.deepEqual(chrome.removedTabIds, [22]);
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
    transientTabs: { linkedin: 12, x: "13" },
    leaseId: "session-1",
  }), {
    windowId: 8,
    tabs: { x: 9 },
    transientTabs: { linkedin: 12 },
    ownedByBridge: true,
    leaseId: "session-1",
  });
});

test("session release closes a canonical tab created by Adaptive capture", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  chrome.addTab(1, "https://x.com/home", 31);

  assert.deepEqual(await runtime.trackOpenedTab("x", 31, "session-1"), {
    tracked: true,
    source: "x",
  });
  assert.equal(await runtime.isTrackedTab("x", 31, "session-1"), true);
  assert.equal(await runtime.isTrackedTab("x", 31, "another-session"), false);
  assert.deepEqual(await runtime.release("session-1"), {
    released: true,
    mode: "owned_transient_tabs_closed",
    closedTabs: 1,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedTabIds, [31]);
  assert.equal(chrome.windowsById.has(1), true);
});

test("release closes a fully Bridge-owned managed window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });

  assert.deepEqual(await runtime.release("session-1"), {
    released: true,
    mode: "owned_window_closed",
    closedTabs: 1,
    closedManagedTabs: 1,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedWindowIds, [2]);
  assert.equal(chrome.windowsById.has(2), false);
});

test("release preserves user tabs added to a Bridge-owned window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  chrome.addTab(2, "https://example.com/user-work", 31);

  assert.deepEqual(await runtime.release("session-1"), {
    released: true,
    mode: "owned_tabs_closed_user_window_preserved",
    closedTabs: 1,
    closedManagedTabs: 1,
    closedTransientTabs: 0,
    preservedUserTabs: 1,
  });
  assert.deepEqual(chrome.removedWindowIds, []);
  assert.deepEqual(chrome.removedTabIds, [21]);
  assert.equal(chrome.windowsById.get(2).tabs[0].id, 31);
});

test("release does not close a newer leased surface", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-2" });

  assert.deepEqual(await runtime.release("session-1"), {
    released: false,
    reason: "lease_mismatch",
  });
  assert.equal(chrome.windowsById.has(2), true);
  assert.deepEqual(chrome.removedWindowIds, []);
});

function fakeChrome() {
  const storage = {};
  const windows = new Map([[1, {
    id: 1,
    tabs: [{ id: 11, windowId: 1, active: true, url: "http://127.0.0.1:11122/" }],
  }]]);
  const tabs = new Map([[11, windows.get(1).tabs[0]]]);
  const activeByWindow = new Map([[1, 11]]);
  const state = {
    focusedWindowId: 1,
    activeByWindow,
    createdWindowOptions: null,
    windowsById: windows,
    removedWindowIds: [],
    removedTabIds: [],
    createdTabOptions: [],
    focusManagedWindowOnTabActivation: false,
    failFocusRestore: false,
    addTab(windowId, url, id) {
      const tab = { id, windowId, active: false, url };
      tabs.set(id, tab);
      windows.get(windowId).tabs.push(tab);
      return tab;
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
      async remove(key) { delete storage[key]; },
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
        if (options.focused && state.failFocusRestore) throw new Error("Focus restore blocked");
        if (options.focused) state.focusedWindowId = id;
        return { id };
      },
      async remove(id) {
        const window = windows.get(id);
        if (!window) throw new Error("No window");
        state.removedWindowIds.push(id);
        for (const tab of window.tabs) tabs.delete(tab.id);
        windows.delete(id);
        activeByWindow.delete(id);
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
        if (options.active) {
          activeByWindow.set(tab.windowId, id);
          if (state.focusManagedWindowOnTabActivation) state.focusedWindowId = tab.windowId;
        }
        return { ...tab, active: options.active === true };
      },
      async create(options) {
        state.createdTabOptions.push({ ...options });
        const id = Math.max(...tabs.keys()) + 1;
        const tab = state.addTab(options.windowId, options.url, id);
        if (options.active) activeByWindow.set(options.windowId, id);
        return { ...tab, active: options.active === true };
      },
      async remove(ids) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = tabs.get(id);
          if (!tab) continue;
          state.removedTabIds.push(id);
          tabs.delete(id);
          const window = windows.get(tab.windowId);
          window.tabs = window.tabs.filter((candidate) => candidate.id !== id);
        }
      },
    },
  };
  return state;
}
