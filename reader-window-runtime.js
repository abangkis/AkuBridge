export const READER_WINDOW_STORAGE_KEY = "akuBridgeReaderWindowV1";

export function createReaderWindowRuntime(chromeApi) {
  let operationTail = Promise.resolve();
  const serialize = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  };
  return Object.freeze({
    currentWindowId: (...args) => serialize(() => currentReaderWindowId(chromeApi, ...args)),
    open: (...args) => serialize(() => openReaderTab(chromeApi, ...args)),
  });
}

async function currentReaderWindowId(chromeApi, options = {}) {
  const excludedWindowIds = new Set(
    Array.isArray(options.excludedWindowIds)
      ? options.excludedWindowIds.filter(Number.isInteger)
      : [],
  );
  const stored = await chromeApi.storage.local.get(READER_WINDOW_STORAGE_KEY);
  const windowId = Number.isInteger(stored?.[READER_WINDOW_STORAGE_KEY]?.windowId)
    ? stored[READER_WINDOW_STORAGE_KEY].windowId
    : null;
  if (windowId === null) return null;
  if (excludedWindowIds.has(windowId)) {
    await chromeApi.storage.local.remove(READER_WINDOW_STORAGE_KEY);
    return null;
  }
  try {
    const window = await chromeApi.windows.get(windowId, { populate: true });
    if (window?.type !== "normal") {
      await chromeApi.storage.local.remove(READER_WINDOW_STORAGE_KEY);
      return null;
    }
    return windowId;
  } catch {
    await chromeApi.storage.local.remove(READER_WINDOW_STORAGE_KEY);
    return null;
  }
}

async function openReaderTab(chromeApi, url, options = {}) {
  const normalizedUrl = new URL(url).href;
  const windowId = await currentReaderWindowId(chromeApi, options);
  let window = null;
  let tab = null;
  let created = false;
  // Only the explicit split Open native post handler supplies this handshake.
  // Register its exact HWND before asking Chrome to foreground it, so native
  // background containment can never race that foreground request.
  const prepareForeground = options.readerIntent ? async (readerId) => {
    const marker = await chromeApi.tabs.create({ windowId: readerId, url: options.readerIntent.url, active: true });
    try { await options.readerIntent.prepare(); }
    finally { if (Number.isInteger(marker?.id)) await chromeApi.tabs.remove(marker.id); }
  } : null;
  if (windowId !== null) {
    window = await chromeApi.windows.get(windowId, { populate: true });
    if (prepareForeground) await prepareForeground(windowId);
    tab = (window.tabs ?? []).find((candidate) => candidate.url === normalizedUrl) ?? null;
    if (tab) {
      tab = await chromeApi.tabs.update(tab.id, { active: true });
    } else {
      tab = await chromeApi.tabs.create({
        windowId,
        url: normalizedUrl,
        active: true,
      });
    }
    if (prepareForeground) await chromeApi.windows.update(windowId, { state: "normal" });
    await chromeApi.windows.update(windowId, { focused: true });
  } else {
    window = await chromeApi.windows.create({
      // A cold window starts on the marker itself. Creating a remote post
      // first and immediately adding another active tab can race Chromium's
      // initial tab selection/title initialization and can hide the marker.
      url: prepareForeground ? options.readerIntent.url : normalizedUrl,
      focused: !prepareForeground,
      type: "normal",
      width: 960,
      height: 900,
    });
    tab = window.tabs?.[0] ?? null;
    created = true;
    if (!Number.isInteger(window?.id) || !Number.isInteger(tab?.id)) {
      throw new Error("Chrome did not return a complete native-reader window binding.");
    }
    await chromeApi.storage.local.set({
      [READER_WINDOW_STORAGE_KEY]: { windowId: window.id },
    });
    if (prepareForeground) {
      await options.readerIntent.prepare();
      // Reuse the bound marker tab: never close the only tab in a new window.
      tab = await chromeApi.tabs.update(tab.id, { url: normalizedUrl, active: true });
      await chromeApi.windows.update(window.id, { state: "normal" });
      await chromeApi.windows.update(window.id, { focused: true });
    }
  }
  if (options.readerIntent) await options.readerIntent.foreground();
  return {
    windowId: window?.id ?? windowId,
    tabId: tab?.id ?? null,
    url: tab?.url ?? normalizedUrl,
    created,
  };
}
