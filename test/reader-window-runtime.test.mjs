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
        const window = windows.get(id);
        if (!window) throw new Error("window not found");
        Object.assign(window, changes);
        return { ...window };
      },
    },
    tabs: {
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
