import { expectedFeedUrl, isCanonicalFeedUrl } from "./source-tab-policy.js";
import { sourceForUrl, sourceIds } from "./source-catalog.js";

export const CAPTURE_WINDOW_STORAGE_KEY = "akuBridgeManagedCaptureWindowV1";
export const CAPTURE_SURFACE_LEDGER_STORAGE_KEY = "akuBridgeManagedCaptureSurfaceLedgerV2";
const MAX_LEDGER_RECEIPTS = 100;

export function createManagedCaptureWindowRuntime(chromeApi) {
  return Object.freeze({
    async prepare(
      source,
      { openIfMissing = true, leaseId = null, windowIsolation = "shared" } = {},
    ) {
      const focusSnapshot = await captureWorkingFocus(chromeApi);
      const state = await loadState(chromeApi);
      const isolation = normalizeWindowIsolation(windowIsolation);
      const reconciliationEvents = await reconcileLedger(
        chromeApi,
        state,
        normalizeLeaseId(leaseId),
      );
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
      await recordLedgerSurface(chromeApi, {
        windowId: binding.windowId,
        isolation,
        bindings: isolation === "per_source"
          ? { [source]: binding.tabId }
          : claimedState.tabs,
        leaseId: claimedState.leaseId,
        created: opened,
      });

      const current = await chromeApi.tabs.get(binding.tabId);
      if (current.active !== true) await chromeApi.tabs.update(binding.tabId, { active: true });
      const focusOutcome = await requirePreservedFocus(chromeApi, focusSnapshot, binding.windowId, {
        source,
        reason: "managed_window_took_focus",
        phase: "prepare",
      });
      const lifecycleEvents = [
        ...reconciliationEvents,
        lifecycleEvent(opened ? "created" : "reused", source, {
          isolation,
          reset,
          focusIntervention: focusOutcome.changed === true,
          focusRestored: focusOutcome.restored === true,
        }),
      ];
      if (focusOutcome.changed === true) {
        lifecycleEvents.push(lifecycleEvent("focus_intervention", source, {
          phase: "prepare",
          restored: focusOutcome.restored === true,
        }));
      }

      return {
        tab: await chromeApi.tabs.get(binding.tabId),
        opened,
        reset,
        focusSnapshot,
        lifecycleEvents,
        openTargetTab: (url) => openManagedTargetTab(
          chromeApi,
          url,
          focusSnapshot,
          binding.windowId,
          source,
          lifecycleEvents,
        ),
        showForeground: async () => {
          const result = await chromeApi.windows.update(binding.windowId, { focused: true });
          lifecycleEvents.push(lifecycleEvent("focus_intervention", source, {
            phase: "foreground_authorized",
            restored: false,
            userAuthorized: true,
          }));
          return result;
        },
        verifyFocus: () => preserveWorkingFocus(
          chromeApi,
          focusSnapshot,
          binding.windowId,
        ),
        requireFocus: async (phase) => {
          const outcome = await requirePreservedFocus(
            chromeApi,
            focusSnapshot,
            binding.windowId,
            { source, reason: "managed_window_took_focus", phase },
          );
          if (outcome.changed === true) {
            lifecycleEvents.push(lifecycleEvent("focus_intervention", source, {
              phase,
              restored: outcome.restored === true,
            }));
          }
          return outcome;
        },
      };
    },
    async reconcile() {
      const state = await loadState(chromeApi);
      return { events: await reconcileLedger(chromeApi, state) };
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
      await recordLedgerSurface(chromeApi, {
        surfaceId: `transient-tab:${tabId}`,
        windowId: tab.windowId,
        kind: "transient_tab",
        isolation: "shared",
        bindings: { [source]: tabId },
        leaseId: requestedLeaseId,
        created: true,
      });
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
      const transientTabId = state.transientTabs[source];
      if (Number.isInteger(transientTabId)) {
        let transientTab = null;
        try {
          transientTab = await chromeApi.tabs.get(transientTabId);
        } catch {
          // The tab was already closed by Chrome or by the user.
        }
        delete state.transientTabs[source];
        await persistRemainingState(chromeApi, state);
        const stillBridgeOwned = Boolean(transientTab && (
          isCanonicalFeedUrl(transientTab.url, source) ||
          sourceForUrl(transientTab.url) === source
        ));
        if (stillBridgeOwned) {
          await chromeApi.tabs.remove(transientTabId);
        }
        const outcome = stillBridgeOwned
          ? "owned_transient_tab_closed"
          : transientTab
            ? "transient_tab_adopted_by_user"
            : "transient_tab_already_closed";
        const events = [];
        if (transientTab && !stillBridgeOwned) {
          events.push(lifecycleEvent("preserved_user_owned", source, {
            outcome,
            preservedUserTabs: 1,
          }));
        }
        events.push(lifecycleEvent("released", source, {
          outcome,
          closedTabs: stillBridgeOwned ? 1 : 0,
          preservedUserTabs: transientTab && !stillBridgeOwned ? 1 : 0,
        }));
        await recordLedgerRelease(
          chromeApi,
          transientTab?.windowId ?? null,
          source,
          outcome,
          transientTabId,
        );
        return {
          released: stillBridgeOwned,
          mode: outcome,
          closedTabs: stillBridgeOwned ? 1 : 0,
          preservedUserTabs: transientTab && !stillBridgeOwned ? 1 : 0,
          events,
        };
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
        const events = [lifecycleEvent("released", source, { outcome: "surface_already_closed" })];
        await recordLedgerRelease(chromeApi, surfaceWindowId, source, "surface_already_closed");
        return { released: false, reason: "surface_already_closed", events };
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
      const events = [];
      if (userTabs.length > 0) {
        events.push(lifecycleEvent("preserved_user_owned", source, {
          preservedUserTabs: userTabs.length,
        }));
      }
      events.push(lifecycleEvent("released", source, {
        outcome: targetOwned ? "owned_source_surface_closed" : "source_surface_already_closed",
        closedTabs: targetOwned ? 1 : 0,
        preservedUserTabs: userTabs.length,
      }));
      await recordLedgerRelease(
        chromeApi,
        surfaceWindowId,
        source,
        targetOwned ? "owned_source_surface_closed" : "source_surface_already_closed",
      );
      return {
        released: targetOwned,
        mode: targetOwned ? "owned_source_surface_closed" : "source_surface_already_closed",
        closedTabs: targetOwned ? 1 : 0,
        remainingManagedTabs,
        preservedUserTabs: userTabs.length,
        events,
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
      const transientBindings = { ...state.transientTabs };
      const transient = await closeTrackedTabs(chromeApi, transientBindings);
      for (const [source, tabId] of Object.entries(transientBindings)) {
        await recordLedgerRelease(
          chromeApi,
          null,
          source,
          transient.closedBySource[source]
            ? "owned_transient_tab_closed"
            : "transient_tab_preserved",
          tabId,
        );
      }
      const transientEvents = Object.keys(transientBindings).flatMap((source) => {
        const closed = transient.closedBySource[source] === true;
        return [
          ...(!closed ? [lifecycleEvent("preserved_user_owned", source, {
            outcome: "transient_tab_preserved",
            preservedUserTabs: 1,
          })] : []),
          lifecycleEvent("released", source, {
            outcome: closed ? "owned_transient_tab_closed" : "transient_tab_preserved",
            closedTabs: closed ? 1 : 0,
            preservedUserTabs: closed ? 0 : 1,
          }),
        ];
      });
      if (!hasManagedWindows) {
        await clearState(chromeApi);
        return {
          released: transient.closedTabs > 0,
          mode: "owned_transient_tabs_closed",
          closedTabs: transient.closedTabs,
          preservedUserTabs: transient.preservedTabs,
          events: transientEvents,
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
        for (const source of Object.keys(surface.bindings)) {
          await recordLedgerRelease(chromeApi, surface.windowId, source, userTabs.length > 0
            ? "owned_tabs_closed_user_window_preserved"
            : "owned_window_closed");
        }
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
        events: [
          ...transientEvents,
          ...surfaces.flatMap((surface) => Object.keys(surface.bindings).map((source) =>
            lifecycleEvent("released", source, {
              outcome: mode,
              preservedUserTabs,
            }))),
        ],
      };
    },
  });
}

async function openManagedTargetTab(
  chromeApi,
  url,
  focusSnapshot,
  managedWindowId,
  source,
  lifecycleEvents = [],
) {
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
    const createdFocus = await requirePreservedFocus(chromeApi, focusSnapshot, managedWindowId, {
      source,
      reason: "managed_target_creation_took_focus",
      phase: "target_created",
    });
    if (createdFocus.changed === true) {
      lifecycleEvents.push(lifecycleEvent("focus_intervention", source, {
        phase: "target_created",
        restored: createdFocus.restored === true,
      }));
    }
    await chromeApi.tabs.update(targetTab.id, { active: true });
    const activatedFocus = await requirePreservedFocus(chromeApi, focusSnapshot, managedWindowId, {
      source,
      reason: "managed_target_activation_took_focus",
      phase: "target_activated",
    });
    if (activatedFocus.changed === true) {
      lifecycleEvents.push(lifecycleEvent("focus_intervention", source, {
        phase: "target_activated",
        restored: activatedFocus.restored === true,
      }));
    }
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

async function loadLedger(chromeApi) {
  const stored = await chromeApi.storage.local.get(CAPTURE_SURFACE_LEDGER_STORAGE_KEY);
  return normalizeSurfaceLedger(stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY]);
}

async function saveLedger(chromeApi, ledger) {
  await chromeApi.storage.local.set({
    [CAPTURE_SURFACE_LEDGER_STORAGE_KEY]: normalizeSurfaceLedger(ledger),
  });
}

export function normalizeSurfaceLedger(value) {
  const surfaces = Array.isArray(value?.surfaces)
    ? value.surfaces.flatMap((surface) => {
        const kind = surface?.kind === "transient_tab"
          ? "transient_tab"
          : "managed_window";
        if (!Number.isInteger(surface?.windowId)) return [];
        const bindings = Object.fromEntries(sourceIds().flatMap((source) =>
          Number.isInteger(surface?.bindings?.[source])
            ? [[source, surface.bindings[source]]]
            : [],
        ));
        if (Object.keys(bindings).length === 0) return [];
        const fallbackSurfaceId = kind === "transient_tab"
          ? `transient-tab:${Object.values(bindings)[0]}`
          : `managed-window:${surface.windowId}`;
        const storedSurfaceId = typeof surface.surfaceId === "string"
          ? surface.surfaceId
          : "";
        return [{
          surfaceId: storedSurfaceId && !storedSurfaceId.startsWith("window:")
            ? storedSurfaceId
            : fallbackSurfaceId,
          windowId: surface.windowId,
          kind,
          isolation: surface.isolation === "per_source" ? "per_source" : "shared",
          bindings,
          leaseId: normalizeLeaseId(surface.leaseId),
          createdAt: normalizeLedgerTimestamp(surface.createdAt),
          updatedAt: normalizeLedgerTimestamp(surface.updatedAt),
        }];
      })
    : [];
  const receipts = Array.isArray(value?.receipts)
    ? value.receipts.slice(-MAX_LEDGER_RECEIPTS).flatMap((receipt) =>
        typeof receipt?.event === "string" && typeof receipt?.occurredAt === "string"
          ? [{
              event: receipt.event,
              source: sourceIds().includes(receipt.source) ? receipt.source : null,
              outcome: String(receipt.outcome ?? "").slice(0, 120),
              occurredAt: receipt.occurredAt,
            }]
          : [],
      )
    : [];
  return { version: 2, surfaces, receipts };
}

async function recordLedgerSurface(chromeApi, value) {
  const ledger = await loadLedger(chromeApi);
  const surfaceId = typeof value.surfaceId === "string" && value.surfaceId
    ? value.surfaceId
    : `managed-window:${value.windowId}`;
  const existing = ledger.surfaces.find((surface) => surface.surfaceId === surfaceId);
  const timestamp = new Date().toISOString();
  if (existing) {
    existing.bindings = { ...existing.bindings, ...value.bindings };
    existing.isolation = value.isolation;
    existing.leaseId = normalizeLeaseId(value.leaseId);
    existing.updatedAt = timestamp;
  } else {
    ledger.surfaces.push({
      surfaceId,
      windowId: value.windowId,
      kind: value.kind === "transient_tab" ? "transient_tab" : "managed_window",
      isolation: value.isolation,
      bindings: { ...value.bindings },
      leaseId: normalizeLeaseId(value.leaseId),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  await saveLedger(chromeApi, ledger);
}

async function recordLedgerRelease(chromeApi, windowId, source, outcome, tabId = null) {
  const ledger = await loadLedger(chromeApi);
  const surface = ledger.surfaces.find((candidate) =>
    candidate.bindings[source] === tabId ||
    (tabId === null && candidate.windowId === windowId && candidate.kind !== "transient_tab")
  );
  if (surface) {
    delete surface.bindings[source];
    surface.updatedAt = new Date().toISOString();
    if (Object.keys(surface.bindings).length === 0) {
      ledger.surfaces = ledger.surfaces.filter((candidate) => candidate !== surface);
    }
  }
  appendLedgerReceipt(ledger, "released", source, outcome);
  await saveLedger(chromeApi, ledger);
}

async function reconcileLedger(chromeApi, state, incomingLeaseId = null) {
  const ledger = await loadLedger(chromeApi);
  await migrateStateIntoLedger(chromeApi, ledger, state);
  const priorLeaseMustRelease = Boolean(
    incomingLeaseId &&
    state.leaseId &&
    state.leaseId !== incomingLeaseId,
  );
  const currentSurfaceIds = priorLeaseMustRelease
    ? new Set()
    : new Set([
        ...managedSurfaces(state).map((surface) => `managed-window:${surface.windowId}`),
        ...Object.values(state.transientTabs).map((tabId) => `transient-tab:${tabId}`),
      ]);
  const events = [];
  for (const surface of [...ledger.surfaces]) {
    let window;
    try {
      window = await chromeApi.windows.get(surface.windowId, { populate: true });
    } catch {
      for (const source of Object.keys(surface.bindings)) {
        appendLedgerReceipt(ledger, "released", source, "surface_already_closed");
        events.push(lifecycleEvent("reconciled", source, { outcome: "surface_already_closed" }));
      }
      ledger.surfaces = ledger.surfaces.filter((candidate) => candidate !== surface);
      continue;
    }

    const ownedTabs = [];
    for (const [source, tabId] of Object.entries({ ...surface.bindings })) {
      const tab = (window.tabs ?? []).find((candidate) => candidate.id === tabId);
      if (!tab) {
        delete surface.bindings[source];
        appendLedgerReceipt(ledger, "released", source, "owned_tab_already_closed");
        events.push(lifecycleEvent("reconciled", source, { outcome: "owned_tab_already_closed" }));
        continue;
      }
      if (!isCanonicalFeedUrl(tab.url, source) && sourceForUrl(tab.url) !== source) {
        delete surface.bindings[source];
        appendLedgerReceipt(ledger, "preserved_user_owned", source, "navigation_adopted_by_user");
        events.push(lifecycleEvent("preserved_user_owned", source, {
          outcome: "navigation_adopted_by_user",
        }));
        continue;
      }
      ownedTabs.push(tab);
    }

    if (!currentSurfaceIds.has(surface.surfaceId) && ownedTabs.length > 0) {
      const ownedIds = new Set(ownedTabs.map((tab) => tab.id));
      const userTabs = (window.tabs ?? []).filter((tab) => !ownedIds.has(tab.id));
      if (userTabs.length === 0) {
        await chromeApi.windows.remove(surface.windowId);
      } else {
        await chromeApi.tabs.remove(ownedTabs.map((tab) => tab.id));
      }
      for (const source of Object.keys(surface.bindings)) {
        appendLedgerReceipt(
          ledger,
          "released",
          source,
          userTabs.length === 0 ? "orphan_window_reconciled" : "orphan_tabs_reconciled",
        );
        events.push(lifecycleEvent("reconciled", source, {
          outcome: userTabs.length === 0 ? "orphan_window_reconciled" : "orphan_tabs_reconciled",
          preservedUserTabs: userTabs.length,
        }));
        if (userTabs.length > 0) {
          events.push(lifecycleEvent("preserved_user_owned", source, {
            outcome: "orphan_user_tabs_preserved",
            preservedUserTabs: userTabs.length,
          }));
        }
      }
      ledger.surfaces = ledger.surfaces.filter((candidate) => candidate !== surface);
      continue;
    }

    if (Object.keys(surface.bindings).length === 0) {
      ledger.surfaces = ledger.surfaces.filter((candidate) => candidate !== surface);
    } else {
      surface.updatedAt = new Date().toISOString();
    }
  }
  await saveLedger(chromeApi, ledger);
  if (priorLeaseMustRelease) {
    state.windowId = null;
    state.tabs = {};
    state.sourceWindows = {};
    state.transientTabs = {};
    state.ownedByBridge = false;
    state.leaseId = null;
    await clearState(chromeApi);
  }
  return events;
}

async function migrateStateIntoLedger(chromeApi, ledger, state) {
  const now = new Date().toISOString();
  for (const surface of managedSurfaces(state)) {
    const existing = ledger.surfaces.find((candidate) => candidate.windowId === surface.windowId);
    if (existing) {
      existing.bindings = { ...existing.bindings, ...surface.bindings };
      existing.leaseId = state.leaseId;
      existing.updatedAt = now;
      continue;
    }
    ledger.surfaces.push({
      surfaceId: `managed-window:${surface.windowId}`,
      windowId: surface.windowId,
      kind: "managed_window",
      isolation: Object.keys(surface.bindings).length === 1 &&
        Object.values(state.sourceWindows).some((binding) => binding.windowId === surface.windowId)
        ? "per_source"
        : "shared",
      bindings: { ...surface.bindings },
      leaseId: state.leaseId,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const [source, tabId] of Object.entries(state.transientTabs)) {
    const surfaceId = `transient-tab:${tabId}`;
    const existing = ledger.surfaces.find((candidate) => candidate.surfaceId === surfaceId);
    if (existing) {
      existing.bindings = { ...existing.bindings, [source]: tabId };
      existing.leaseId = state.leaseId;
      existing.updatedAt = now;
      continue;
    }
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      continue;
    }
    ledger.surfaces.push({
      surfaceId,
      windowId: tab.windowId,
      kind: "transient_tab",
      isolation: "shared",
      bindings: { [source]: tabId },
      leaseId: state.leaseId,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function appendLedgerReceipt(ledger, event, source, outcome) {
  ledger.receipts.push({
    event,
    source: sourceIds().includes(source) ? source : null,
    outcome: String(outcome ?? "").slice(0, 120),
    occurredAt: new Date().toISOString(),
  });
  ledger.receipts = ledger.receipts.slice(-MAX_LEDGER_RECEIPTS);
}

function lifecycleEvent(event, source, detail = {}) {
  return {
    event,
    source: sourceIds().includes(source) ? source : null,
    outcome: String(detail.outcome ?? "").slice(0, 120),
    detail: { ...detail },
    occurredAt: new Date().toISOString(),
  };
}

function normalizeLedgerTimestamp(value) {
  return typeof value === "string" && value ? value : new Date().toISOString();
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
  const closedBySource = {};
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
      closedBySource[source] = true;
    } else {
      // Navigation is treated as user adoption. Never close an adopted tab.
      preservedTabs += 1;
    }
  }
  if (closeIds.length > 0) await chromeApi.tabs.remove(closeIds);
  return { closedTabs: closeIds.length, preservedTabs, closedBySource };
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
