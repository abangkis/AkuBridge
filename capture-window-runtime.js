import { expectedFeedUrl, isCanonicalFeedUrl } from "./source-tab-policy.js";
import { sourceForUrl, sourceIds } from "./source-catalog.js";

export const CAPTURE_WINDOW_STORAGE_KEY = "akuBridgeManagedCaptureWindowV1";

export function createManagedCaptureWindowRuntime(chromeApi) {
  return Object.freeze({
    async prepare(
      source,
      { openIfMissing = true, leaseId = null, windowIsolation = "shared" } = {},
    ) {
      const focusSnapshot = await captureWorkingFocus(chromeApi);
      const state = await loadState(chromeApi);
      const isolation = normalizeWindowIsolation(windowIsolation);
      let binding = await validateBinding(chromeApi, state, source, isolation);
      let opened = false;
      let reset = binding?.reset === true;

      if (!binding) {
        if (!openIfMissing) {
          throw visibilityError(
            `Quiet capture has no managed ${source} feed tab and opening one is disabled.`,
            { source, reason: "managed_tab_missing" },
          );
        }
        binding = await createBinding(chromeApi, state, source, isolation);
        opened = true;
        reset = false;
      }

      const claimedState = normalizeManagedCaptureState(binding.state ?? state);
      if (isolation === "per_source") {
        claimedState.sourceWindows[source] = {
          windowId: binding.windowId,
          tabId: binding.tabId,
        };
      } else {
        claimedState.windowId = binding.windowId;
        claimedState.tabs[source] = binding.tabId;
      }
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
        reset,
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
    async trackOpenedTab(source, tabId, leaseId) {
      if (!Number.isInteger(tabId) || !sourceIds().includes(source)) {
        throw visibilityError("Bridge-created source tab tracking received an invalid binding.", {
          source,
          reason: "transient_tab_invalid",
        });
      }
      const tab = await chromeApi.tabs.get(tabId);
      if (!isCanonicalFeedUrl(tab.url, source)) {
        throw visibilityError("Bridge-created source tab left its canonical feed before tracking.", {
          source,
          reason: "transient_tab_wrong_page",
        });
      }
      const state = await loadState(chromeApi);
      const requestedLeaseId = normalizeLeaseId(leaseId);
      if (state.leaseId && state.leaseId !== requestedLeaseId) {
        throw visibilityError("A different capture lease already owns the transient source tabs.", {
          source,
          reason: "transient_tab_lease_conflict",
        });
      }
      state.transientTabs[source] = tabId;
      state.ownedByBridge = true;
      state.leaseId = requestedLeaseId;
      await saveState(chromeApi, state);
      return { tracked: true, source };
    },
    async isTrackedTab(source, tabId, leaseId) {
      const state = await loadState(chromeApi);
      return state.leaseId === normalizeLeaseId(leaseId) &&
        state.transientTabs[source] === tabId;
    },
    async releaseSource(source, leaseId) {
      if (!sourceIds().includes(source)) {
        return { released: false, reason: "unknown_source" };
      }
      const state = await loadState(chromeApi);
      const requestedLeaseId = normalizeLeaseId(leaseId);
      if (state.leaseId && state.leaseId !== requestedLeaseId) {
        return { released: false, reason: "lease_mismatch" };
      }
      const isolatedBinding = state.sourceWindows[source] ?? null;
      const surfaceWindowId = isolatedBinding?.windowId ?? state.windowId;
      const tabId = isolatedBinding?.tabId ?? state.tabs[source];
      if (!Number.isInteger(tabId) || !state.ownedByBridge) {
        return { released: false, reason: "no_owned_source_surface" };
      }

      let window;
      try {
        window = await chromeApi.windows.get(surfaceWindowId, { populate: true });
      } catch {
        removeSourceBinding(state, source, isolatedBinding !== null);
        await persistRemainingState(chromeApi, state);
        return { released: false, reason: "surface_already_closed" };
      }
      const bindings = isolatedBinding
        ? { [source]: isolatedBinding.tabId }
        : state.tabs;
      const ownedTabs = ownedTabsInWindow(window.tabs ?? [], bindings);
      const ownedIds = new Set(ownedTabs.map((tab) => tab.id));
      const userTabs = (window.tabs ?? []).filter((tab) => !ownedIds.has(tab.id));
      const targetOwned = ownedIds.has(tabId);
      const remainingManagedTabs = ownedTabs.filter((tab) => tab.id !== tabId).length;

      removeSourceBinding(state, source, isolatedBinding !== null);
      if (targetOwned && remainingManagedTabs === 0 && userTabs.length === 0) {
        await chromeApi.windows.remove(surfaceWindowId);
        if (!isolatedBinding) {
          state.windowId = null;
          state.tabs = {};
        }
      } else if (targetOwned) {
        await chromeApi.tabs.remove(tabId);
      }
      await persistRemainingState(chromeApi, state);
      return {
        released: targetOwned,
        mode: targetOwned ? "owned_source_surface_closed" : "source_surface_already_closed",
        closedTabs: targetOwned ? 1 : 0,
        remainingManagedTabs,
        preservedUserTabs: userTabs.length,
      };
    },
    async release(leaseId) {
      const state = await loadState(chromeApi);
      const requestedLeaseId = normalizeLeaseId(leaseId);
      const hasTransientTabs = Object.keys(state.transientTabs).length > 0;
      const hasManagedWindows = state.windowId !== null ||
        Object.keys(state.sourceWindows).length > 0;
      if ((!hasManagedWindows && !hasTransientTabs) || !state.ownedByBridge) {
        return { released: false, reason: "no_owned_surface" };
      }
      if (state.leaseId && state.leaseId !== requestedLeaseId) {
        return { released: false, reason: "lease_mismatch" };
      }
      const transient = await closeTrackedTabs(chromeApi, state.transientTabs);
      if (!hasManagedWindows) {
        await clearState(chromeApi);
        return {
          released: transient.closedTabs > 0,
          mode: "owned_transient_tabs_closed",
          closedTabs: transient.closedTabs,
          preservedUserTabs: transient.preservedTabs,
        };
      }
      const surfaces = managedSurfaces(state);
      let closedManagedTabs = 0;
      let preservedUserTabs = transient.preservedTabs;
      let closedWindows = 0;
      for (const surface of surfaces) {
        let window;
        try {
          window = await chromeApi.windows.get(surface.windowId, { populate: true });
        } catch {
          continue;
        }
        const ownedTabs = ownedTabsInWindow(window.tabs ?? [], surface.bindings);
        const ownedIds = new Set(ownedTabs.map((tab) => tab.id));
        const userTabs = (window.tabs ?? []).filter((tab) => !ownedIds.has(tab.id));
        preservedUserTabs += userTabs.length;
        if (ownedTabs.length > 0 && userTabs.length === 0) {
          await chromeApi.windows.remove(surface.windowId);
          closedWindows += 1;
        } else if (ownedTabs.length > 0) {
          await chromeApi.tabs.remove(ownedTabs.map((tab) => tab.id));
        }
        closedManagedTabs += ownedTabs.length;
      }
      await clearState(chromeApi);
      const released = closedManagedTabs > 0 || transient.closedTabs > 0;
      const mode = closedWindows === surfaces.length && surfaces.length > 0
        ? (surfaces.length === 1 ? "owned_window_closed" : "owned_windows_closed")
        : "owned_tabs_closed_user_window_preserved";
      return {
        released,
        mode,
        closedTabs: closedManagedTabs + transient.closedTabs,
        closedManagedTabs,
        closedTransientTabs: transient.closedTabs,
        preservedUserTabs,
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
    sourceIds().flatMap((source) =>
      Number.isInteger(value?.tabs?.[source]) ? [[source, value.tabs[source]]] : [],
    ),
  );
  const transientTabs = Object.fromEntries(
    sourceIds().flatMap((source) =>
      Number.isInteger(value?.transientTabs?.[source])
        ? [[source, value.transientTabs[source]]]
        : [],
    ),
  );
  const sourceWindows = Object.fromEntries(
    sourceIds().flatMap((source) => {
      const binding = value?.sourceWindows?.[source];
      return Number.isInteger(binding?.windowId) && Number.isInteger(binding?.tabId)
        ? [[source, { windowId: binding.windowId, tabId: binding.tabId }]]
        : [];
    }),
  );
  return {
    windowId,
    tabs,
    sourceWindows,
    transientTabs,
    ownedByBridge:
      value?.ownedByBridge === true ||
      windowId !== null ||
      Object.keys(sourceWindows).length > 0 ||
      Object.keys(transientTabs).length > 0,
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

async function persistRemainingState(chromeApi, state) {
  const hasManagedTabs = Object.keys(state.tabs).length > 0;
  const hasSourceWindows = Object.keys(state.sourceWindows).length > 0;
  const hasTransientTabs = Object.keys(state.transientTabs).length > 0;
  if (!hasManagedTabs && !hasSourceWindows && !hasTransientTabs) {
    await clearState(chromeApi);
    return;
  }
  await saveState(chromeApi, state);
}

async function validateBinding(chromeApi, state, source, isolation) {
  const isolatedBinding = isolation === "per_source"
    ? state.sourceWindows[source]
    : null;
  const windowId = isolatedBinding?.windowId ?? state.windowId;
  if (!windowId) return null;
  let window;
  try {
    window = await chromeApi.windows.get(windowId, { populate: true });
  } catch {
    if (isolatedBinding) {
      delete state.sourceWindows[source];
    } else {
      state.windowId = null;
      state.tabs = {};
    }
    await persistRemainingState(chromeApi, state);
    return null;
  }
  const rememberedId = isolatedBinding?.tabId ?? state.tabs[source];
  const tab = (window.tabs ?? []).find((candidate) =>
    !candidate.discarded && candidate.id === rememberedId
  );
  if (!tab) {
    removeSourceBinding(state, source, isolatedBinding !== null);
    await persistRemainingState(chromeApi, state);
    return null;
  }
  if (isCanonicalFeedUrl(tab.url, source)) {
    return { windowId: window.id, tabId: tab.id, state, reset: false };
  }
  if (sourceForUrl(tab.url) === source) {
    await chromeApi.tabs.update(tab.id, {
      url: expectedFeedUrl(source),
      active: true,
    });
    return { windowId: window.id, tabId: tab.id, state, reset: true };
  }
  removeSourceBinding(state, source, isolatedBinding !== null);
  await persistRemainingState(chromeApi, state);
  return null;
}

async function createBinding(chromeApi, state, source, isolation) {
  let windowId = isolation === "per_source" ? null : state.windowId;
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
  if (isolation === "per_source") {
    next.sourceWindows[source] = { windowId, tabId: tab.id };
  } else {
    next.windowId = windowId;
    next.tabs[source] = tab.id;
  }
  await saveState(chromeApi, next);
  return { windowId, tabId: tab.id, state: next };
}

function ownedTabsInWindow(tabs, bindings) {
  return sourceIds().flatMap((source) => {
    const id = bindings[source];
    const tab = tabs.find((candidate) =>
      candidate.id === id && (
        isCanonicalFeedUrl(candidate.url, source) ||
        sourceForUrl(candidate.url) === source
      )
    );
    return tab ? [tab] : [];
  });
}

function managedSurfaces(state) {
  const surfaces = [];
  if (Number.isInteger(state.windowId)) {
    surfaces.push({ windowId: state.windowId, bindings: state.tabs });
  }
  for (const [source, binding] of Object.entries(state.sourceWindows)) {
    surfaces.push({
      windowId: binding.windowId,
      bindings: { [source]: binding.tabId },
    });
  }
  return surfaces;
}

function removeSourceBinding(state, source, isolated) {
  if (isolated) {
    delete state.sourceWindows[source];
  } else {
    delete state.tabs[source];
  }
}

function normalizeWindowIsolation(value) {
  return value === "per_source" ? "per_source" : "shared";
}

async function closeTrackedTabs(chromeApi, bindings) {
  const closeIds = [];
  let preservedTabs = 0;
  for (const [source, id] of Object.entries(bindings)) {
    let tab;
    try {
      tab = await chromeApi.tabs.get(id);
    } catch {
      continue;
    }
    if (isCanonicalFeedUrl(tab.url, source)) {
      closeIds.push(id);
    } else {
      // Navigation is treated as user adoption. Never close an adopted tab.
      preservedTabs += 1;
    }
  }
  if (closeIds.length > 0) await chromeApi.tabs.remove(closeIds);
  return { closedTabs: closeIds.length, preservedTabs };
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
