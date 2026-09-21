import test from "node:test";
import assert from "node:assert/strict";
import {
  READER_WINDOW_STORAGE_KEY,
  createReaderWindowRuntime,
} from "../reader-window-runtime.js";

test("native reader creates a dedicated window and reuses it for later posts", async () => {
  const chrome = fakeChrome();
  const runtime = createReaderWindowRuntime(chrome);

  const first = await runtime.open("https://x.com/aku/status/101", {
    excludedWindowIds: [1],
  });
  const second = await runtime.open("https://x.com/aku/status/102", {
    excludedWindowIds: [1],
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.windowId, 2);
  assert.equal(second.windowId, 2);
  assert.equal(chrome.createdWindows.length, 1);
  assert.deepEqual(chrome.createdTabs.at(-1), {
    windowId: 2,
    url: "https://x.com/aku/status/102",
    active: true,
  });
  assert.deepEqual(chrome.storageState[READER_WINDOW_STORAGE_KEY], { windowId: 2 });
});

test("native reader activates an existing exact post instead of duplicating it", async () => {
  const chrome = fakeChrome();
  const runtime = createReaderWindowRuntime(chrome);
  const first = await runtime.open("https://x.com/aku/status/101");
  const second = await runtime.open("https://x.com/aku/status/101");

  assert.equal(second.tabId, first.tabId);
  assert.equal(chrome.createdTabs.length, 0);
  assert.deepEqual(chrome.updatedTabs.at(-1), [first.tabId, { active: true }]);
});

test("native reader discards a binding that collides with a managed capture window", async () => {
  const chrome = fakeChrome();
  chrome.storageState[READER_WINDOW_STORAGE_KEY] = { windowId: 1 };
  const opened = await createReaderWindowRuntime(chrome).open(
    "https://www.linkedin.com/feed/update/urn:li:activity:123",
    { excludedWindowIds: [1] },
  );

  assert.equal(opened.created, true);
  assert.equal(opened.windowId, 2);
  assert.deepEqual(chrome.removedStorageKeys, [READER_WINDOW_STORAGE_KEY]);
});

function fakeChrome() {
  const storageState = {};
  const windows = new Map([[1, { id: 1, type: "normal", focused: true, tabs: [] }]]);
  const tabs = new Map();
  let nextWindowId = 2;
  let nextTabId = 20;
  const chrome = {
    storageState,
    removedStorageKeys: [],
    createdWindows: [],
    createdTabs: [],
    updatedTabs: [],
    updatedWindows: [],
    removedTabs: [],
    storage: {
      local: {
        async get(key) {
          return { [key]: storageState[key] };
        },
        async set(value) {
          Object.assign(storageState, value);
        },
        async remove(key) {
          chrome.removedStorageKeys.push(key);
          delete storageState[key];
        },
      },
    },
    windows: {
      async get(id) {
        const window = windows.get(id);
        if (!window) throw new Error("window not found");
        return { ...window, tabs: window.tabs.map((tab) => ({ ...tab })) };
      },
      async create(options) {
        chrome.createdWindows.push(options);
        const id = nextWindowId++;
        const tab = { id: nextTabId++, windowId: id, url: options.url, active: true };
        const window = { id, type: options.type, focused: options.focused, tabs: [tab] };
        windows.set(id, window);
        tabs.set(tab.id, tab);
        return { ...window, tabs: [{ ...tab }] };
      },
      async update(id, changes) {
        chrome.updatedWindows.push([id, changes]);
        const window = windows.get(id);
        if (!window) throw new Error("window not found");
        Object.assign(window, changes);
        return { ...window };
      },
    },
    tabs: {
      async remove(id) {
        chrome.removedTabs.push(id);
        const tab = tabs.get(id);
        if (tab) windows.get(tab.windowId).tabs = windows.get(tab.windowId).tabs.filter((t) => t.id !== id);
        tabs.delete(id);
      },
      async create(options) {
        chrome.createdTabs.push(options);
        const tab = { id: nextTabId++, ...options };
        tabs.set(tab.id, tab);
        windows.get(options.windowId).tabs.push(tab);
        return { ...tab };
      },
      async update(id, changes) {
        chrome.updatedTabs.push([id, changes]);
        const tab = tabs.get(id);
        if (!tab) throw new Error("tab not found");
        Object.assign(tab, changes);
        return { ...tab };
      },
    },
  };
  return chrome;
}

test("split reused minimized reader restores normal before requesting focus", async () => {
  const chrome = fakeChrome();
  const reader = createReaderWindowRuntime(chrome);
  const first = await reader.open("https://x.com/aku/status/101");
  await chrome.windows.update(first.windowId, { state: "minimized" });
  await reader.open("https://x.com/aku/status/101", { readerIntent: {
    url: "http://127.0.0.1:11122/split-reader-intent?id=split_one",
    prepare: async () => {}, foreground: async () => {},
  } });
  assert.deepEqual(chrome.updatedWindows.slice(-2), [[first.windowId, { state: "normal" }], [first.windowId, { focused: true }]]);
});

test("ordinary reader retains its existing focus-only behavior", async () => {
  const chrome = fakeChrome();
  const reader = createReaderWindowRuntime(chrome);
  await reader.open("https://x.com/aku/status/101");
  await reader.open("https://x.com/aku/status/102");
  assert.deepEqual(chrome.updatedWindows, [[2, { focused: true }]]);
  assert.equal(chrome.removedTabs.length, 0);
});

for (const reuse of [false, true]) test(`split reader binds exact window before foreground, reuse=${reuse}`, async () => {
  const chrome = fakeChrome();
  const reader = createReaderWindowRuntime(chrome);
  if (reuse) {
    const first = await reader.open("https://x.com/aku/status/101");
    await chrome.windows.update(first.windowId, { state: "minimized" });
  }
  const before = chrome.updatedWindows.length;
  const markerURL = "http://127.0.0.1:11122/split-reader-intent?id=split_one";
  let prepared = false;
  let foregrounded = false;
  const result = await reader.open("https://x.com/aku/status/102", { readerIntent: {
    url: markerURL,
    prepare: async () => {
      const window = await chrome.windows.get(2);
      assert.equal(window.tabs.at(-1).url, markerURL);
      if (!reuse) {
        assert.equal(window.tabs.length, 1);
        assert.equal(chrome.createdTabs.length, 0);
        assert.equal(chrome.updatedTabs.length, 0);
      }
      assert.equal(chrome.updatedWindows.length, before);
      prepared = true;
    },
    foreground: async () => {
      assert.equal(prepared, true);
      assert.equal(chrome.removedTabs.length, reuse ? 1 : 0);
      const window = await chrome.windows.get(2);
      assert.equal(window.tabs.some((tab) => tab.url === markerURL), false);
      assert.equal(window.tabs.at(-1).url, "https://x.com/aku/status/102");
      assert.deepEqual(chrome.updatedWindows.slice(-2), [[2, { state: "normal" }], [2, { focused: true }]]);
      foregrounded = true;
    },
  } });
  assert.equal(foregrounded, true);
  assert.equal(result.windowId, 2);
  if (!reuse) assert.equal(chrome.createdWindows[0].focused, false);
});

test("failed reused reader binding cleans marker and never invokes foreground", async () => {
  const chrome = fakeChrome();
  const reader = createReaderWindowRuntime(chrome);
  await reader.open("https://x.com/aku/status/101");
  let foregrounded = false;
  await assert.rejects(reader.open("https://x.com/aku/status/101", { readerIntent: {
    url: "http://127.0.0.1:11122/split-reader-intent?id=split_one",
    prepare: async () => { throw new Error("ownership rejected"); },
    foreground: async () => { foregrounded = true; },
  } }), /ownership rejected/);
  assert.equal(chrome.removedTabs.length, 1);
  assert.equal(chrome.updatedWindows.length, 0);
  assert.equal(foregrounded, false);
});

test("native foreground rejection is surfaced to the explicit caller", async () => {
  const chrome = fakeChrome();
  await assert.rejects(createReaderWindowRuntime(chrome).open("https://x.com/aku/status/101", { readerIntent: {
    url: "http://127.0.0.1:11122/split-reader-intent?id=split_one",
    prepare: async () => {},
    foreground: async () => { throw new Error("Windows rejected foreground"); },
  } }), /Windows rejected foreground/);
});

test("cold reader binding failure never navigates or focuses an unbound window", async () => {
  const chrome = fakeChrome();
  let foregrounded = false;
  await assert.rejects(createReaderWindowRuntime(chrome).open("https://x.com/aku/status/101", { readerIntent: {
    url: "http://127.0.0.1:11122/split-reader-intent?id=split_one",
    prepare: async () => { throw new Error("marker not ready"); },
    foreground: async () => { foregrounded = true; },
  } }), /marker not ready/);
  assert.equal(chrome.createdWindows[0].focused, false);
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.updatedTabs.length, 0);
  assert.equal(chrome.updatedWindows.length, 0);
  assert.equal(foregrounded, false);
});
