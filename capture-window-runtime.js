import { expectedFeedUrl, isCanonicalFeedUrl } from "./source-tab-policy.js";

export const CAPTURE_WINDOW_STORAGE_KEY = "akuBridgeManagedCaptureWindowV1";

export function createManagedCaptureWindowRuntime(chromeApi) {
  return Object.freeze({
    async prepare(source, { openIfMissing = true } = {}) {
      const focusSnapshot = await captureWorkingFocus(chromeApi);
      const state = await loadState(chromeApi);
      let binding = await validateBinding(chromeApi, state, source);
      let opened = false;

      if (!binding) {
        if (!openIfMissing) {
          throw visibilityError(
            `Quiet capture has no managed ${source} feed tab and opening one is disabled.`,
            { source, reason: "managed_tab_missing" },
          );
        }
        binding = await createBinding(chromeApi, state, source);
        opened = true;
      }

      const current = await chromeApi.tabs.get(binding.tabId);
      if (current.active !== true) await chromeApi.tabs.update(binding.tabId, { active: true });
      const focusOutcome = await preserveWorkingFocus(chromeApi, focusSnapshot);
      if (focusOutcome.changed) {
        throw visibilityError(
          "Chrome focused the managed capture surface while Quiet capture was preparing it.",
          { source, reason: "managed_window_took_focus", focusOutcome },
        );
      }

      return {
        tab: await chromeApi.tabs.get(binding.tabId),
        opened,
        focusSnapshot,
        verifyFocus: () => preserveWorkingFocus(chromeApi, focusSnapshot),
      };
    },
  });
}

export function normalizeManagedCaptureState(value) {
  const windowId = Number.isInteger(value?.windowId) ? value.windowId : null;
  const tabs = Object.fromEntries(
    ["x", "linkedin"].flatMap((source) =>
      Number.isInteger(value?.tabs?.[source]) ? [[source, value.tabs[source]]] : [],
    ),
  );
  return { windowId, tabs };
}

async function loadState(chromeApi) {
  const stored = await chromeApi.storage.local.get(CAPTURE_WINDOW_STORAGE_KEY);
  return normalizeManagedCaptureState(stored[CAPTURE_WINDOW_STORAGE_KEY]);
}

async function saveState(chromeApi, state) {
  await chromeApi.storage.local.set({
    [CAPTURE_WINDOW_STORAGE_KEY]: normalizeManagedCaptureState(state),
  });
}

async function validateBinding(chromeApi, state, source) {
  if (!state.windowId) return null;
  let window;
  try {
    window = await chromeApi.windows.get(state.windowId, { populate: true });
  } catch {
    await saveState(chromeApi, { windowId: null, tabs: {} });
    return null;
  }
  const rememberedId = state.tabs[source];
  const tab = (window.tabs ?? []).find((candidate) =>
    !candidate.discarded && (
      candidate.id === rememberedId || isCanonicalFeedUrl(candidate.url, source)
    ),
  );
  if (!tab) return null;
  if (rememberedId !== tab.id) {
    state.tabs[source] = tab.id;
    await saveState(chromeApi, state);
  }
  return { windowId: window.id, tabId: tab.id };
}

async function createBinding(chromeApi, state, source) {
  let windowId = state.windowId;
  let tab;
  if (!windowId) {
    const created = await chromeApi.windows.create({
      url: expectedFeedUrl(source),
      focused: false,
      type: "normal",
      width: 960,
      height: 900,
    });
    windowId = created.id;
    tab = created.tabs?.[0] ?? null;
  } else {
    tab = await chromeApi.tabs.create({
      windowId,
      url: expectedFeedUrl(source),
      active: false,
    });
  }
  if (!Number.isInteger(windowId) || !Number.isInteger(tab?.id)) {
    throw visibilityError("Chrome did not return a complete managed capture binding.", {
      source,
      reason: "managed_binding_incomplete",
    });
  }
  const next = normalizeManagedCaptureState(state);
  next.windowId = windowId;
  next.tabs[source] = tab.id;
  await saveState(chromeApi, next);
  return { windowId, tabId: tab.id };
}

async function captureWorkingFocus(chromeApi) {
  try {
    const window = await chromeApi.windows.getLastFocused();
    if (!Number.isInteger(window?.id)) return null;
    const activeTab = (await chromeApi.tabs.query({ active: true, windowId: window.id }))[0];
    return { windowId: window.id, tabId: activeTab?.id ?? null };
  } catch {
    return null;
  }
}

async function preserveWorkingFocus(chromeApi, snapshot) {
  if (!snapshot?.windowId) {
    return { changed: false, restored: false, preserved: true };
  }
  let currentWindow;
  let currentTab;
  try {
    currentWindow = await chromeApi.windows.getLastFocused();
    currentTab = (await chromeApi.tabs.query({
      active: true,
      windowId: snapshot.windowId,
    }))[0];
  } catch {
    return { changed: true, restored: false, preserved: false };
  }
  const changed = currentWindow?.id !== snapshot.windowId || (
    Number.isInteger(snapshot.tabId) && currentTab?.id !== snapshot.tabId
  );
  if (!changed) return { changed: false, restored: false, preserved: true };
  try {
    if (Number.isInteger(snapshot.tabId)) {
      await chromeApi.tabs.update(snapshot.tabId, { active: true });
    }
    await chromeApi.windows.update(snapshot.windowId, { focused: true });
    const verifiedWindow = await chromeApi.windows.getLastFocused();
    const verifiedTab = (await chromeApi.tabs.query({
      active: true,
      windowId: snapshot.windowId,
    }))[0];
    const restored = verifiedWindow?.id === snapshot.windowId && (
      !Number.isInteger(snapshot.tabId) || verifiedTab?.id === snapshot.tabId
    );
    return { changed: true, restored, preserved: false };
  } catch {
    return { changed: true, restored: false, preserved: false };
  }
}

function visibilityError(message, details) {
  const error = new Error(message);
  error.code = "visible_recovery_required";
  error.stage = "capture_visibility";
  error.details = details;
  return error;
}

