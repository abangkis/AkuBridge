import { isBridgeOwnedFeedUrl } from "./source-tab-policy.js";
import { sourceIds } from "./source-catalog.js";

export const CLEANUP_JOURNAL_KEY = "akuBridgeSurfaceCleanupJournalV1";
const STATE_KEY = "akuBridgeManagedCaptureWindowV1";
const LEDGER_KEY = "akuBridgeManagedCaptureSurfaceLedgerV2";
const GENERATION_KEY = "akuBridgeSurfaceOwnerGenerationV1";
const MAX_RECORDS = 4096;
const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validGeneration = value => typeof value === "string" && value.length === 36 && GENERATION_PATTERN.test(value);
const validId = value => Number.isSafeInteger(value) && value >= 0;

// Records survive ambiguous navigation, API errors, and service-worker restarts.
export function createSurfaceCleanupJournal(chrome) {
  const read = async () => {
    const stored = await chrome.storage.local.get(CLEANUP_JOURNAL_KEY);
    const rows = stored[CLEANUP_JOURNAL_KEY];
    if (rows === undefined) return [];
    validate(rows);
    return rows.map(row => ({ ...row, ...(!row.ownerGeneration ? { status: "pending" } : {}) }));
  };
  const save = rows => {
    validate(rows);
    return chrome.storage.local.set({ [CLEANUP_JOURNAL_KEY]: rows });
  };
  function validate(rows) {
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS || Array.from(rows).some(row =>
      !row || typeof row !== "object" || Array.isArray(row) ||
      !validId(row.tabId) || !(row.windowId === null || validId(row.windowId)) ||
      !(row.leaseId === null || typeof row.leaseId === "string" && row.leaseId.length >= 1 && row.leaseId.length <= 200) ||
      !["batch_capture", "lease_placeholder"].includes(row.role) ||
      !["active", "pending", "closed", "retained"].includes(row.status) ||
      (row.role === "batch_capture" ? !sourceIds().includes(row.source) : row.source !== null) ||
      (row.retainedFor !== undefined && !sourceIds().includes(row.retainedFor)) ||
      (row.status === "retained" && (row.role !== "lease_placeholder" || !sourceIds().includes(row.retainedFor))) ||
      (row.ownerGeneration !== undefined && row.ownerGeneration !== null && !validGeneration(row.ownerGeneration))
    )) throw pendingError("Capture surface journal is invalid; ownership requires operator resolution.");
  }
  async function generation() {
    try {
      const session = chrome.storage.session;
      if (!session) return null;
      const stored = await session.get(GENERATION_KEY);
      if (stored[GENERATION_KEY] !== undefined) {
        if (!validGeneration(stored[GENERATION_KEY])) throw pendingError("Capture surface owner generation is invalid.");
        return stored[GENERATION_KEY];
      }
      const value = globalThis.crypto.randomUUID();
      await session.set({ [GENERATION_KEY]: value });
      return value;
    } catch (error) {
      if (error?.code === "cleanup_pending") throw error;
      return null;
    }
  }
  function pendingError(message = "Capture surface cleanup remains unverified.") {
    const error = new Error(message);
    error.code = "cleanup_pending";
    return error;
  }
  async function inventory(rows, ownerGeneration = null) {
    const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] ?? {};
    const ledger = (await chrome.storage.local.get(LEDGER_KEY))[LEDGER_KEY] ?? {};
    const add = (tabId, windowId, source, leaseId, role = "batch_capture") => {
      if (!Number.isInteger(tabId)) return;
      if (!rows.some(row => row.tabId === tabId && row.leaseId === leaseId &&
          (row.status !== "closed" || !ownerGeneration || row.ownerGeneration === ownerGeneration))) {
        if (rows.length >= MAX_RECORDS) throw pendingError("Capture surface journal capacity requires operator resolution.");
        rows.push({ tabId, windowId, source, leaseId: leaseId ?? null, role, ownerGeneration, status: "active" });
      }
    };
    for (const surface of ledger.surfaces ?? []) {
      for (const [source, id] of Object.entries(surface.bindings ?? {})) add(id, surface.windowId, source, surface.leaseId);
      add(surface.placeholderTabId, surface.windowId, null, surface.leaseId, "lease_placeholder");
    }
    for (const [source, id] of Object.entries(state.tabs ?? {})) add(id, state.windowId, source, state.leaseId);
    for (const [source, binding] of Object.entries(state.sourceWindows ?? {})) add(binding.tabId, binding.windowId, source, state.leaseId);
    for (const [source, id] of Object.entries(state.transientTabs ?? {})) add(id, null, source, state.leaseId);
    add(state.placeholderTabId, state.windowId, null, state.leaseId, "lease_placeholder");
    return state;
  }
  // A failed tabs.get is not absence proof. Inventory must succeed explicitly.
  async function observe(row) {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.id === row.tabId) ?? null;
  }
  function receipt(rows, leaseId, source) {
    const selected = rows.filter(row => row.leaseId === leaseId && (source === null || row.source === source || row.retainedFor === source));
    const closed = selected.filter(row => row.status === "closed").length;
    const retained = selected.filter(row => row.status === "retained" && row.role === "lease_placeholder" && source !== null).length;
    const pending = selected.length - closed - retained;
    return { schema: "aku.surface-cleanup.v1", leaseId, source, expected: selected.length, closed, transferred: 0, retained, pending, complete: pending === 0 };
  }
  return {
    async release(leaseId, source, operation) {
      leaseId ??= null;
      const ownerGeneration = await generation();
      const rows = await read();
      const state = await inventory(rows);
      await save(rows);
      const selected = rows.filter(row => row.leaseId === leaseId && row.status !== "closed" && (source === null || row.source === source));
      let unsafe = Boolean(state.leaseId && state.leaseId !== leaseId);
      for (const row of selected) {
        if (!ownerGeneration || row.ownerGeneration !== ownerGeneration) {
          unsafe = true;
          row.status = "pending";
          continue;
        }
        try {
          const tab = await observe(row);
          if (!tab) { row.status = "closed"; continue; }
          const matches = (!Number.isInteger(row.windowId) || row.windowId === tab.windowId) &&
            (row.role === "lease_placeholder"
              ? tab.url === chrome.runtime.getURL("capture-placeholder.html")
              : isBridgeOwnedFeedUrl(tab.url, row.source));
          if (!matches || tab.pendingUrl && tab.pendingUrl !== tab.url) unsafe = true;
          row.status = "pending";
        } catch { unsafe = true; row.status = "pending"; }
      }
      await save(rows);
      let outcome;
      if (unsafe) outcome = { released: false, reason: state.leaseId && state.leaseId !== leaseId ? "lease_mismatch" : "cleanup_pending" };
      else {
        try { outcome = await operation(); }
        catch { outcome = { released: false, reason: "cleanup_pending" }; }
        // The guarded operation can create its lease placeholder before a
        // later close fails. Register that new surface in this same generation.
        await inventory(rows, ownerGeneration);
        // The legacy state may have disappeared after a failed close. The
        // durable record remains authoritative, but only for a reverified feed.
        if (["no_owned_surface", "no_owned_source_surface"].includes(outcome.reason)) {
          for (const row of selected.filter(row => row.status !== "closed")) {
            try {
              const tab = await observe(row);
              if (tab && (!Number.isInteger(row.windowId) || tab.windowId === row.windowId) &&
                  !tab.pendingUrl && row.role === "batch_capture" && isBridgeOwnedFeedUrl(tab.url, row.source)) {
                await chrome.tabs.remove(row.tabId);
              }
            } catch { /* Keep the record pending until absence is verified. */ }
          }
        }
        for (const row of selected) {
          if (row.status === "closed") continue;
          try { row.status = await observe(row) ? "pending" : "closed"; }
          catch { row.status = "pending"; }
        }
        if (source !== null && outcome.windowRetained === true) {
          await inventory(rows, ownerGeneration);
          for (const row of rows.filter(row => row.leaseId === leaseId && row.role === "lease_placeholder" && row.status !== "closed")) {
            try {
              const tab = await observe(row);
              if (tab?.url === chrome.runtime.getURL("capture-placeholder.html") && !tab.pendingUrl) {
                row.status = "retained";
                row.retainedFor = source;
              }
            } catch { row.status = "pending"; }
          }
        }
      }
      await save(rows);
      const cleanup = receipt(rows, leaseId, source);
      if (!cleanup.complete && outcome.reason !== "lease_mismatch") outcome = { ...outcome, released: false, reason: "cleanup_pending" };
      return {
        ...outcome,
        cleanup,
        events: [
          ...(outcome.events ?? []),
          {
            event: "reconciled",
            source,
            outcome: cleanup.complete && outcome.reason !== "lease_mismatch"
              ? "cleanup_verified" : "cleanup_pending",
            detail: { cleanup, cleanupScope: "browser_lease" },
            occurredAt: new Date().toISOString(),
          },
        ],
      };
    },
    async assertReady() {
      const ownerGeneration = await generation();
      const rows = await read();
      await inventory(rows);
      for (const row of rows.filter(row => row.status !== "closed")) {
        if (!ownerGeneration || row.ownerGeneration !== ownerGeneration) {
          row.status = "pending";
          continue;
        }
        try {
          const tab = await observe(row);
          if (!tab) row.status = "closed";
          else if ((Number.isInteger(row.windowId) && tab.windowId !== row.windowId) ||
              (tab.pendingUrl && tab.pendingUrl !== tab.url) ||
              (row.role === "lease_placeholder" ? tab.url !== chrome.runtime.getURL("capture-placeholder.html") : !isBridgeOwnedFeedUrl(tab.url, row.source))) row.status = "pending";
        } catch { row.status = "pending"; }
      }
      await save(rows);
      if (rows.some(row => row.status === "pending")) {
        throw pendingError();
      }
      // Reserve room for a new capture and its optional lease placeholder.
      if (!ownerGeneration || rows.length > MAX_RECORDS - 2) throw pendingError("Capture surface ownership or journal capacity is unavailable.");
    },
    async capture() {
      const rows = await read();
      await inventory(rows, await generation());
      await save(rows);
    },
  };
}
