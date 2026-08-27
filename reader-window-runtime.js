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
  if (windowId !== null) {
    window = await chromeApi.windows.get(windowId, { populate: true });
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
    await chromeApi.windows.update(windowId, { focused: true });
  } else {
    window = await chromeApi.windows.create({
      url: normalizedUrl,
      focused: true,
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
  }
  return {
    windowId: window?.id ?? windowId,
    tabId: tab?.id ?? null,
    url: tab?.url ?? normalizedUrl,
    created,
  };
}
