import { isBridgeOwnedFeedUrl } from "./source-tab-policy.js";
import { sourceIds } from "./source-catalog.js";

export const CLEANUP_JOURNAL_KEY = "akuBridgeSurfaceCleanupJournalV1";
export const CLEANUP_JOURNAL_BACKUP_KEY = "akuBridgeSurfaceCleanupJournalBackupLatest";
const STATE_KEY = "akuBridgeManagedCaptureWindowV1";
const LEDGER_KEY = "akuBridgeManagedCaptureSurfaceLedgerV2";
const GENERATION_KEY = "akuBridgeSurfaceOwnerGenerationV1";
const MAX_RECORDS = 4096;
const ARCHIVE_SCHEMA = "aku.surface-cleanup-archive.v1";
const journalValue = (rows, archive) => archive ? { schema: ARCHIVE_SCHEMA, rows, archive } : rows;
const hasCapacity = count => count <= MAX_RECORDS - 2;
const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validGeneration = value => typeof value === "string" && value.length === 36 && GENERATION_PATTERN.test(value);
const validId = value => Number.isSafeInteger(value) && value >= 0;

// Chrome storage round trips may reorder object keys.
function canonicalJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

// Fixed categories only: no tab/window IDs, lease values, URLs, or API messages.
function diagnostics(phase, rows, leaseId, state = {}) {
  const counts = {};
  let firstReason = "none";
  const currentLeasePresent = Boolean(state.leaseId);
  const currentLeaseMatches = state.leaseId ? state.leaseId === leaseId : null;
  return {
    note(reason) {
      if (firstReason === "none") firstReason = reason;
      counts[reason] = Math.min(MAX_RECORDS, (counts[reason] ?? 0) + 1);
    },
    project(runtimeLeaseMatches = null) {
      const pending = rows.filter(row => row.status === "pending");
      return {
        schema: "aku.surface-pending-diagnostic.v1", phase, firstReason,
        reasonCounts: { ...counts }, pending: pending.length,
        sameLease: pending.filter(row => row.leaseId === leaseId && leaseId !== null).length,
        otherLease: pending.filter(row => row.leaseId !== null && row.leaseId !== leaseId).length,
        unscopedLease: pending.filter(row => row.leaseId === null).length,
        currentLeasePresent, currentLeaseMatches,
        runtimeLeaseMatches,
      };
    },
  };
}

// Records survive ambiguous navigation, API errors, and service-worker restarts.
export function createSurfaceCleanupJournal(chrome) {
  async function readStored() {
    const stored = await chrome.storage.local.get(CLEANUP_JOURNAL_KEY);
    const value = stored[CLEANUP_JOURNAL_KEY];
    if (value?.schema !== ARCHIVE_SCHEMA) {
      const rows = value === undefined ? [] : value;
      validate(rows);
      return { rows, archive: null };
    }
    const { rows, archive } = value;
    validate(rows);
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) throw pendingError("Capture surface archive is invalid.");
    return { rows, archive };
  }
  const read = async () => {
    const { rows, archive } = await readStored();
    return { rows: rows.map(row => ({ ...row, ...(!row.ownerGeneration ? { status: "pending" } : {}) })), archive };
  };
  const save = (rows, archive) => {
    validate(rows);
    // One storage item commits the archived tombstones and the new live journal together.
    return chrome.storage.local.set({ [CLEANUP_JOURNAL_KEY]: journalValue(rows, archive) });
  };
  async function backUpJournal(rows, archive) {
    const snapshot = journalValue(rows, archive);
    const expected = canonicalJSON(snapshot);
    await chrome.storage.local.set({ [CLEANUP_JOURNAL_BACKUP_KEY]: snapshot });
    const stored = await chrome.storage.local.get(CLEANUP_JOURNAL_BACKUP_KEY);
    if (canonicalJSON(stored[CLEANUP_JOURNAL_BACKUP_KEY]) !== expected) {
      throw pendingError("The capture journal backup could not be verified.");
    }
  }
  function validate(rows, max = MAX_RECORDS) {
    if (!Array.isArray(rows) || rows.length > max || Array.from(rows).some(row =>
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
  function pendingError(message = "Capture surface cleanup remains unverified.", diagnostic = null) {
    const error = new Error(message);
    error.code = "cleanup_pending";
    if (diagnostic) {
      error.details = { cleanupDiagnostics: diagnostic };
      error.captureSurfaceLifecycle = [{ event: "reconciled", source: null,
        outcome: "cleanup_pending", detail: error.details, occurredAt: new Date().toISOString() }];
    }
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
  function matches(row, tab) {
    return (!Number.isInteger(row.windowId) || row.windowId === tab.windowId) &&
      !(tab.pendingUrl && tab.pendingUrl !== tab.url) &&
      (row.role === "lease_placeholder"
        ? tab.url === chrome.runtime.getURL("capture-placeholder.html")
        : isBridgeOwnedFeedUrl(tab.url, row.source));
  }
  function mismatchReasons(row, tab, ownerGeneration) {
    const reasons = [];
    if (!ownerGeneration) reasons.push("owner_generation_unavailable");
    else if (!row.ownerGeneration) reasons.push("record_generation_missing");
    else if (row.ownerGeneration !== ownerGeneration) reasons.push("owner_generation_mismatch");
    if (Number.isInteger(row.windowId) && row.windowId !== tab.windowId) reasons.push("window_mismatch");
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) reasons.push("navigation_pending");
    if (row.role === "lease_placeholder"
      ? tab.url !== chrome.runtime.getURL("capture-placeholder.html")
      : !isBridgeOwnedFeedUrl(tab.url, row.source)) reasons.push("url_not_owned");
    return reasons;
  }
  function archivedRows(archive, leaseId) {
    if (!archive || !Object.hasOwn(archive, leaseId) || leaseId === null) return [];
    const rows = archive[leaseId];
    validate(rows, Infinity);
    if (!rows.every(row => row.leaseId === leaseId && row.status === "closed" && row.ownerGeneration)) {
      throw pendingError("Archived cleanup receipt is invalid.");
    }
    return rows;
  }
  function receipt(rows, leaseId, source, archived) {
    const matchesLeaseAndSource = row => row.leaseId === leaseId && (source === null || row.source === source || row.retainedFor === source);
    const selected = rows.filter(matchesLeaseAndSource).concat(archived.filter(matchesLeaseAndSource));
    const closed = selected.filter(row => row.status === "closed").length;
    const retained = selected.filter(row => row.status === "retained" && row.role === "lease_placeholder" && source !== null).length;
    const pending = selected.length - closed - retained;
    return { schema: "aku.surface-cleanup.v1", leaseId, source, expected: selected.length, closed, transferred: 0, retained, pending, complete: pending === 0 };
  }
  function inspectJournal(rows, bindings) {
    const recorded = new Set(rows.map(row => JSON.stringify([row.tabId, row.leaseId])));
    const unrecorded = bindings.filter(row => !recorded.has(JSON.stringify([row.tabId, row.leaseId]))).length;
    return {
      recordsUsed: rows.length, capacity: MAX_RECORDS,
      capacityBlocked: !hasCapacity(rows.length + unrecorded),
      protectedRecords: rows.filter(row => row.status !== "closed" || !row.ownerGeneration).length,
    };
  }
  async function planArchive() {
    const { rows, archive } = await readStored();
    const bindings = [];
    const state = await inventory(bindings);
    const status = inspectJournal(rows, bindings);
    const liveTabs = new Set((await chrome.tabs.query({})).map(tab => tab.id));
    const boundTabs = new Set(bindings.map(row => row.tabId));
    const blockedLeases = new Set([null, state.leaseId, ...bindings.map(row => row.leaseId)]);
    for (const row of rows) {
      if (row.status !== "closed" || !row.ownerGeneration || liveTabs.has(row.tabId) || boundTabs.has(row.tabId)) blockedLeases.add(row.leaseId);
    }
    const eligible = status.capacityBlocked ? rows.filter(row => !blockedLeases.has(row.leaseId)) : [];
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON([rows, eligible])));
    const previewToken = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const preview = { ...status, protectedRecords: rows.filter(row => blockedLeases.has(row.leaseId)).length,
      eligibleRecords: eligible.length, previewToken, backupPolicy: "latest_verified" };
    return { rows, archive, eligible, preview };
  }
  return {
    async maintenanceStatus() {
      const { rows } = await readStored();
      const bindings = [];
      await inventory(bindings);
      return inspectJournal(rows, bindings);
    },
    async maintenancePreview() {
      return (await planArchive()).preview;
    },
    async archiveClosed(previewToken) {
      const plan = await planArchive();
      if (plan.preview.previewToken !== previewToken || !plan.eligible.length) {
        return { outcome: "review_required", ...plan.preview };
      }
      const archive = Object.assign(Object.create(null), plan.archive);
      const eligible = new Set(plan.eligible);
      const archiveLeases = new Set(plan.eligible.map(row => row.leaseId));
      for (const leaseId of archiveLeases) archive[leaseId] = [...archivedRows(archive, leaseId)];
      for (const row of plan.eligible) archive[row.leaseId].push(row);
      const rows = plan.rows.filter(row => !eligible.has(row));
      await backUpJournal(plan.rows, plan.archive);
      await save(rows, archive);
      const verified = await readStored();
      for (const leaseId of archiveLeases) {
        const stored = archivedRows(verified.archive, leaseId);
        if (canonicalJSON(stored) !== canonicalJSON(archive[leaseId])) throw pendingError("Capture surface archive could not be verified.");
      }
      if (canonicalJSON(verified.rows) !== canonicalJSON(rows)) throw pendingError("Capture surface journal could not be verified.");
      const bindings = [];
      await inventory(bindings);
      const preserved = Object.fromEntries(["active", "pending", "retained"].map(status =>
        [status, verified.rows.filter(row => row.status === status).length]));
      return { outcome: "archived", archivedRecords: eligible.size, backupRecords: plan.rows.length,
        preserved, ...inspectJournal(verified.rows, bindings) };
    },
    async assertReloadReady() {
      const { rows, archive } = await read();
      await inventory(rows);
      const bindings = [];
      await inventory(bindings);
      // Only successful absence proof may settle a record here. A matching
      // generation or URL does not authorize reload to dispose of a live tab.
      const tabs = await chrome.tabs.query({});
      for (const row of rows) {
        if (row.status !== "closed" && !tabs.some(tab => tab.id === row.tabId)) row.status = "closed";
      }
      await save(rows, archive);
      if (rows.some(row => row.status !== "closed") || bindings.some(row => tabs.some(tab => tab.id === row.tabId))) throw pendingError();
    },
    async release(leaseId, source, operation) {
      leaseId ??= null;
      const ownerGeneration = await generation();
      const { rows, archive } = await read();
      const historical = archivedRows(archive, leaseId);
      const state = await inventory(rows);
      const diagnostic = diagnostics("release", rows, leaseId, state);
      await save(rows, archive);
      const selected = rows.filter(row => row.leaseId === leaseId && row.status !== "closed" &&
        (source === null || row.source === source || row.retainedFor === source));
      const differentCurrentLease = Boolean(state.leaseId && state.leaseId !== leaseId);
      const claimedElsewhere = row => rows.some(other => other.tabId === row.tabId &&
        other.leaseId !== leaseId && other.status !== "closed");
      let unsafe = false;
      for (const row of selected) {
        try {
          const tab = await observe(row);
          // Successful absence proof does not require authority to close a tab.
          if (!tab) { row.status = "closed"; continue; }
          if (!ownerGeneration || row.ownerGeneration !== ownerGeneration || !matches(row, tab) ||
              claimedElsewhere(row)) {
            mismatchReasons(row, tab, ownerGeneration).forEach(reason => diagnostic.note(reason));
            if (claimedElsewhere(row)) diagnostic.note("claimed_by_other_lease");
            unsafe = true;
            row.status = "pending";
          } else if (!(source !== null && row.status === "retained" && row.role === "lease_placeholder")) {
            row.status = "pending";
          }
        } catch { diagnostic.note("inventory_unavailable"); unsafe = true; row.status = "pending"; }
      }
      await save(rows, archive);
      let outcome;
      if (unsafe) outcome = { released: false, reason: "cleanup_pending" };
      else if (differentCurrentLease) {
        // The legacy operation acts on the current singleton state. Retire an
        // older lease only through its own journal records; never mutate that
        // singleton, close a whole window, or touch a newer lease's binding.
        let removed = false;
        for (const row of selected.filter(row => row.status === "pending")) {
          try {
            const tab = await observe(row);
            if (!tab) { row.status = "closed"; continue; }
            if (!matches(row, tab) || claimedElsewhere(row)) continue;
            await chrome.tabs.remove(row.tabId);
            removed = true;
          } catch { /* The journal retains the cleanup obligation. */ }
        }
        for (const row of selected.filter(row => row.status === "pending")) {
          try { if (!await observe(row)) row.status = "closed"; }
          catch { /* An inventory failure is never absence proof. */ }
        }
        outcome = { released: removed, reason: "surface_already_closed" };
      }
      else {
        try { outcome = await operation(); }
        catch { diagnostic.note("release_operation_failed"); outcome = { released: false, reason: "cleanup_pending" }; }
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
          try {
            const tab = await observe(row);
            if (!tab) row.status = "closed";
            else if (!(source !== null && row.status === "retained" && matches(row, tab))) row.status = "pending";
          }
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
      await save(rows, archive);
      const cleanup = receipt(rows, leaseId, source, historical);
      if (outcome.reason === "lease_mismatch") diagnostic.note("runtime_lease_mismatch");
      if (!cleanup.complete && diagnostic.project().firstReason === "none") diagnostic.note("close_unverified");
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
            detail: { cleanup, cleanupScope: "browser_lease",
              cleanupDiagnostics: diagnostic.project(outcome.runtimeLeaseMatches ?? null) },
            occurredAt: new Date().toISOString(),
          },
        ],
      };
    },
    async assertReady(source = null, leaseId = null) {
      const ownerGeneration = await generation();
      const { rows, archive } = await read();
      const state = await inventory(rows);
      const diagnostic = diagnostics("admission", rows, leaseId ?? null, state);
      for (const row of rows.filter(row => row.status !== "closed")) {
        try {
          const tab = await observe(row);
          if (!tab) row.status = "closed";
          else if (!ownerGeneration || row.ownerGeneration !== ownerGeneration || !matches(row, tab)) {
            mismatchReasons(row, tab, ownerGeneration).forEach(reason => diagnostic.note(reason));
            row.status = "pending";
          } else if (row.status === "pending") diagnostic.note("prior_pending_unresolved");
        } catch { diagnostic.note("inventory_unavailable"); row.status = "pending"; }
      }
      await save(rows, archive);
      if (rows.some(row => row.status === "pending")) {
        const error = pendingError(undefined, diagnostic.project());
        error.captureSurfaceLifecycle[0].source = sourceIds().includes(source) ? source : null;
        throw error;
      }
      // Reserve room for a new capture and its optional lease placeholder.
      if (!ownerGeneration || !hasCapacity(rows.length)) {
        diagnostic.note(!ownerGeneration ? "owner_generation_unavailable" : "journal_capacity");
        throw pendingError("Capture surface ownership or journal capacity is unavailable.", diagnostic.project());
      }
    },
    async capture() {
      const { rows, archive } = await read();
      await inventory(rows, await generation());
      await save(rows, archive);
    },
  };
}
