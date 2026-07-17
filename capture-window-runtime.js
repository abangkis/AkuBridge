import { expectedFeedUrl, isCanonicalFeedUrl } from "./source-tab-policy.js";

export const CAPTURE_WINDOW_STORAGE_KEY = "akuBridgeManagedCaptureWindowV1";

export function createManagedCaptureWindowRuntime(chromeApi) {
  return Object.freeze({
    async prepare(source, { openIfMissing = true, leaseId = null } = {}) {
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

      const claimedState = normalizeManagedCaptureState(binding.state ?? state);
      claimedState.windowId = binding.windowId;
      claimedState.tabs[source] = binding.tabId;
      claimedState.ownedByBridge = true;
      claimedState.leaseId = normalizeLeaseId(leaseId);
      await saveState(chromeApi, claimedState);

      const current = await chromeApi.tabs.get(binding.tabId);
      if (current.active !== true) await chromeApi.tabs.update(binding.tabId, { active: true });
      await requirePreservedFocus(chromeApi, focusSnapshot, binding.windowId, {
        source,
        reason: "managed_window_took_focus",
        phase: "prepare",
      });

      return {
        tab: await chromeApi.tabs.get(binding.tabId),
        opened,
        focusSnapshot,
        openTargetTab: (url) => openManagedTargetTab(
          chromeApi,
          url,
          focusSnapshot,
          binding.windowId,
          source,
        ),
        showForeground: () => chromeApi.windows.update(binding.windowId, { focused: true }),
        verifyFocus: () => preserveWorkingFocus(
          chromeApi,
          focusSnapshot,
          binding.windowId,
        ),
        requireFocus: (phase) => requirePreservedFocus(
          chromeApi,
          focusSnapshot,
          binding.windowId,
          { source, reason: "managed_window_took_focus", phase },
        ),
      };
    },
    async release(leaseId) {
      const state = await loadState(chromeApi);
      const requestedLeaseId = normalizeLeaseId(leaseId);
      if (!state.windowId || !state.ownedByBridge) {
        return { released: false, reason: "no_owned_surface" };
      }
      if (state.leaseId && state.leaseId !== requestedLeaseId) {
        return { released: false, reason: "lease_mismatch" };
      }
      let window;
      try {
        window = await chromeApi.windows.get(state.windowId, { populate: true });
      } catch {
        await clearState(chromeApi);
        return { released: false, reason: "surface_already_closed" };
      }
      const ownedTabs = ownedTabsInWindow(window.tabs ?? [], state.tabs);
      const ownedIds = new Set(ownedTabs.map((tab) => tab.id));
      const userTabs = (window.tabs ?? []).filter((tab) => !ownedIds.has(tab.id));
      if (ownedTabs.length > 0 && userTabs.length === 0) {
        await chromeApi.windows.remove(state.windowId);
        await clearState(chromeApi);
        return { released: true, mode: "owned_window_closed", closedTabs: ownedTabs.length };
      }
      if (ownedTabs.length > 0) {
        await chromeApi.tabs.remove(ownedTabs.map((tab) => tab.id));
      }
      await clearState(chromeApi);
      return {
        released: ownedTabs.length > 0,
        mode: "owned_tabs_closed_user_window_preserved",
        closedTabs: ownedTabs.length,
        preservedUserTabs: userTabs.length,
      };
    },
  });
}

async function openManagedTargetTab(chromeApi, url, focusSnapshot, managedWindowId, source) {
  let targetTab = null;
  try {
    // Creating the target inactive avoids the most common Chrome foreground
    // transition. It is activated only inside the already-unfocused managed
    // window so the native post can hydrate without replacing the user's tab.
    targetTab = await chromeApi.tabs.create({
      windowId: managedWindowId,
      url,
      active: false,
    });
    await requirePreservedFocus(chromeApi, focusSnapshot, managedWindowId, {
      source,
      reason: "managed_target_creation_took_focus",
      phase: "target_created",
    });
    await chromeApi.tabs.update(targetTab.id, { active: true });
    await requirePreservedFocus(chromeApi, focusSnapshot, managedWindowId, {
      source,
      reason: "managed_target_activation_took_focus",
      phase: "target_activated",
    });
    return chromeApi.tabs.get(targetTab.id);
  } catch (error) {
    if (Number.isInteger(targetTab?.id)) {
      await chromeApi.tabs.remove(targetTab.id).catch(() => undefined);
    }
    await preserveWorkingFocus(chromeApi, focusSnapshot, managedWindowId).catch(() => undefined);
    throw error;
  }
}

export function normalizeManagedCaptureState(value) {
  const windowId = Number.isInteger(value?.windowId) ? value.windowId : null;
  const tabs = Object.fromEntries(
    ["x", "linkedin"].flatMap((source) =>
      Number.isInteger(value?.tabs?.[source]) ? [[source, value.tabs[source]]] : [],
    ),
  );
  return {
    windowId,
    tabs,
    ownedByBridge: value?.ownedByBridge === true || windowId !== null,
    leaseId: normalizeLeaseId(value?.leaseId),
  };
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

async function clearState(chromeApi) {
  await chromeApi.storage.local.remove(CAPTURE_WINDOW_STORAGE_KEY);
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
    !candidate.discarded &&
    candidate.id === rememberedId &&
    isCanonicalFeedUrl(candidate.url, source),
  );
  if (!tab) return null;
  return { windowId: window.id, tabId: tab.id, state };
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
  return { windowId, tabId: tab.id, state: next };
}

function ownedTabsInWindow(tabs, bindings) {
  return ["x", "linkedin"].flatMap((source) => {
    const id = bindings[source];
    const tab = tabs.find((candidate) =>
      candidate.id === id && isCanonicalFeedUrl(candidate.url, source)
    );
    return tab ? [tab] : [];
  });
}

function normalizeLeaseId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 200
    ? value
    : null;
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

async function preserveWorkingFocus(chromeApi, snapshot, managedWindowId) {
  if (!snapshot?.windowId) {
    return { changed: false, restored: false, preserved: true };
  }
  let currentWindow;
  try {
    currentWindow = await chromeApi.windows.getLastFocused();
  } catch {
    return { changed: true, restored: false, preserved: false };
  }

  // Focus outside the managed surface belongs to the user. Do not undo a tab
  // or window change that happened while a bounded capture was running.
  if (currentWindow?.id !== managedWindowId) {
    return { changed: false, restored: false, preserved: true };
  }

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
    return { changed: true, restored, preserved: restored };
  } catch {
    return { changed: true, restored: false, preserved: false };
  }
}

async function requirePreservedFocus(chromeApi, snapshot, managedWindowId, details) {
  const focusOutcome = await preserveWorkingFocus(chromeApi, snapshot, managedWindowId);
  if (focusOutcome.changed && focusOutcome.preserved !== true) {
    throw visibilityError(
      "Chrome focused the managed capture surface and AkuBridge could not restore the user's working surface.",
      { ...details, focusOutcome },
    );
  }
  return focusOutcome;
}

function visibilityError(message, details) {
  const error = new Error(message);
  error.code = "visible_recovery_required";
  error.stage = "capture_visibility";
  error.details = details;
  return error;
}
