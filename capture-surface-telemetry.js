const WINDOW_STATES = new Set(["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"]);
const WINDOW_TYPES = new Set(["normal", "popup", "panel", "app", "devtools"]);
const TAB_STATUSES = new Set(["unloaded", "loading", "complete"]);

export async function inspectCaptureSurface(chromeApi, tabId) {
  let tab;
  try {
    tab = await chromeApi.tabs.get(tabId);
  } catch {
    return unavailableSurface("tab_unavailable");
  }

  let window;
  try {
    window = await chromeApi.windows.get(tab.windowId);
  } catch {
    return unavailableSurface("window_unavailable", tab);
  }

  return Object.freeze({
    available: true,
    reason: null,
    windowState: WINDOW_STATES.has(window.state) ? window.state : "unknown",
    windowType: WINDOW_TYPES.has(window.type) ? window.type : "unknown",
    windowFocused: window.focused === true,
    windowWidth: boundedDimension(window.width),
    windowHeight: boundedDimension(window.height),
    tabActive: tab.active === true,
    tabDiscarded: tab.discarded === true,
    tabStatus: TAB_STATUSES.has(tab.status) ? tab.status : "unknown",
  });
}

function unavailableSurface(reason, tab = {}) {
  return Object.freeze({
    available: false,
    reason,
    windowState: "unknown",
    windowType: "unknown",
    windowFocused: false,
    windowWidth: 0,
    windowHeight: 0,
    tabActive: tab.active === true,
    tabDiscarded: tab.discarded === true,
    tabStatus: TAB_STATUSES.has(tab.status) ? tab.status : "unknown",
  });
}

function boundedDimension(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, 10_000)) : 0;
}
