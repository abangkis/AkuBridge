const TRUSTED_AKU_BROWSER_ORIGINS = new Set([
  "http://127.0.0.1:11122",
  "http://localhost:11122",
]);

export const AKU_BROWSER_LOOPBACK_URL_PATTERNS = Object.freeze([
  "http://127.0.0.1:11122/*",
  "http://localhost:11122/*",
]);
export const AKU_BROWSER_TAB_BRIDGE_FILE = "aku-browser-tab-bridge.js";
export const AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY = "akuBridgeInstallRecovery.v1";
export const AKU_BROWSER_INSTALL_RECOVERY_ALARM = "akuBridgeInstallRecoveryExpiry";
export const AKU_BROWSER_INSTALL_RECOVERY_TTL_MS = 30_000;
export const AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS = 4;

const RECOVERABLE_MODES = new Set(["development", "production-app"]);
const RECOVERABLE_REASONS = new Set(["install", "update"]);

export function shouldRecoverInstalledAkuBrowserTabs({ mode, reason } = {}) {
  return RECOVERABLE_MODES.has(String(mode ?? "")) &&
    RECOVERABLE_REASONS.has(String(reason ?? ""));
}

export function isTrustedAkuBrowserTab(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || tab.discarded === true) return false;
  if (typeof tab.url !== "string" || tab.url.length === 0) return false;
  try {
    const parsed = new URL(tab.url);
    return TRUSTED_AKU_BROWSER_ORIGINS.has(parsed.origin) &&
      parsed.username === "" &&
      parsed.password === "";
  } catch {
    return false;
  }
}

export function createInstalledAkuBrowserTabRecovery({ reason, version, now = Date.now() } = {}) {
  const normalizedReason = String(reason ?? "");
  const normalizedVersion = String(version ?? "");
  if (!RECOVERABLE_REASONS.has(normalizedReason)) {
    throw new TypeError(`Unsupported AkuBridge install recovery reason: ${normalizedReason || "missing"}`);
  }
  if (!normalizedVersion) throw new TypeError("AkuBridge install recovery requires a version.");
  if (!Number.isFinite(now)) throw new TypeError("AkuBridge install recovery requires a finite timestamp.");
  return Object.freeze({
    schemaVersion: 1,
    eventKey: `${normalizedReason}:${normalizedVersion}`,
    reason: normalizedReason,
    version: normalizedVersion,
    attemptedTabIds: Object.freeze([]),
    createdAt: now,
    expiresAt: now + AKU_BROWSER_INSTALL_RECOVERY_TTL_MS,
  });
}

export function isCurrentInstalledAkuBrowserTabRecovery(state, { now = Date.now() } = {}) {
  const reason = String(state?.reason ?? "");
  const version = typeof state?.version === "string" ? state.version : "";
  return state?.schemaVersion === 1 &&
    typeof state.eventKey === "string" &&
    state.eventKey === `${reason}:${version}` &&
    RECOVERABLE_REASONS.has(reason) &&
    version.length > 0 &&
    Number.isFinite(state.createdAt) &&
    Number.isFinite(state.expiresAt) &&
    state.expiresAt > state.createdAt &&
    state.expiresAt - state.createdAt <= AKU_BROWSER_INSTALL_RECOVERY_TTL_MS &&
    Array.isArray(state.attemptedTabIds) &&
    state.attemptedTabIds.every((tabId) => Number.isInteger(tabId) && tabId >= 0) &&
    state.expiresAt > now;
}

export function selectInstalledAkuBrowserTabs(
  tabs,
  { attemptedTabIds = [], limit = AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS } = {},
) {
  const attempted = new Set(
    Array.isArray(attemptedTabIds)
      ? attemptedTabIds.filter((tabId) => Number.isInteger(tabId))
      : [],
  );
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS)
    : AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS;
  return (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => isTrustedAkuBrowserTab(tab) &&
      (tab.status === undefined || tab.status === "complete") &&
      !attempted.has(tab.id))
    .sort((left, right) => {
      const activeDelta = Number(right.active === true) - Number(left.active === true);
      if (activeDelta !== 0) return activeDelta;
      const completeDelta = Number(right.status === "complete") - Number(left.status === "complete");
      if (completeDelta !== 0) return completeDelta;
      return Number(right.lastAccessed ?? 0) - Number(left.lastAccessed ?? 0);
    })
    .slice(0, boundedLimit);
}
