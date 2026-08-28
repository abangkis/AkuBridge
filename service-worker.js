import {
  chooseSourceTab,
  expectedFeedUrl,
  isCanonicalFeedUrl,
} from "./source-tab-policy.js";
import { shouldRetrySourceTab } from "./tab-recovery-policy.js";
import {
  emptyCaptureDiagnostics,
  observationEvidenceBlockCount,
} from "./capture-observation-policy.js";
import {
  normalizeSourceTabLifecycle,
  shouldCloseOpenedSourceTab,
} from "./source-tab-lifecycle-policy.js";
import {
  AkuBridgeError,
  createCommandGuard,
  createTabLease,
  serializeBridgeError,
  validateTabLease,
} from "./bridge-runtime-policy.js";
import { recoverSourceFreshness } from "./source-freshness-recovery.js";
import {
  planCaptureVisibility,
} from "./capture-visibility-policy.js";
import { createManagedCaptureWindowRuntime } from "./capture-window-runtime.js";
import { createReaderWindowRuntime } from "./reader-window-runtime.js";
import { inspectCaptureSurface } from "./capture-surface-telemetry.js";
import {
  sourceCaptureSurfaceReleasable,
} from "./capture-surface-lifecycle-policy.js";
import {
  managedSurfaceReleaseAllowsRecreate,
  shouldRecoverManagedSurface,
} from "./managed-load-recovery-policy.js";
import { navigationReadinessOutcome } from "./navigation-readiness-policy.js";
import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_ID,
  bridgeCapabilitiesForProtocol,
  createBridgeCapabilities,
} from "./bridge-capabilities.js";
import {
  AKU_BROWSER_LOOPBACK_ORIGIN,
  createChromeNativeRuntimeClient,
} from "./native-runtime-client.js";
import {
  nativeRuntimeDistribution,
  planNativeRuntimeLifecycle,
} from "./native-runtime-lifecycle.js";
import { BRIDGE_DEPLOYMENT } from "./bridge-deployment.js";
import {
  AKU_BROWSER_INSTALL_RECOVERY_ALARM,
  AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS,
  AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY,
  AKU_BROWSER_TAB_BRIDGE_FILE,
  AKU_BROWSER_LOOPBACK_URL_PATTERNS,
  createInstalledAkuBrowserTabRecovery,
  isCurrentInstalledAkuBrowserTabRecovery,
  isTrustedAkuBrowserTab,
  selectInstalledAkuBrowserTabs,
  shouldRecoverInstalledAkuBrowserTabs,
} from "./extension-install-recovery-policy.js";
import {
  NATIVE_RUNTIME_CHECK_ALARM,
  createNativeRuntimeScheduler,
} from "./native-runtime-scheduler.js";
import {
  reconcileRegisteredSourceScripts,
  revokeAllSourceAccess,
  sourceAccessGranted,
  sourceAccessReadiness,
  sourcesForGrantedOrigins,
} from "./source-access-policy.js";
import { resolveXStructuredMediaInMainWorld } from "./x-main-world-media-resolver.js";
import { resolveLinkedInStructuredMediaInMainWorld } from "./linkedin-main-world-media-resolver.js";
import { resolveFacebookStructuredMediaInMainWorld } from "./facebook-main-world-media-resolver.js";
import { resolveInstagramStructuredMediaInMainWorld } from "./instagram-main-world-media-resolver.js";
import {
  instagramStructuredFeedObservation,
  resolveInstagramStructuredFeedInMainWorld,
  shouldUseInstagramStructuredFeedFallback,
} from "./instagram-main-world-feed-resolver.js";
import {
  captureWithParallelStructuredMedia,
  collectStructuredMediaWithinBudget,
} from "./structured-media-collection-runtime.js";
import { createXMediaEvidenceStore } from "./x-media-evidence-store.js";
import { createXAvatarEvidenceStore } from "./x-avatar-evidence-store.js";
import {
  isNativePostUrl,
  matchPatternsFor,
  sourceRuntimeScripts,
  sourceDefinition,
  sourceIds,
  sourceForUrl,
  sourceRequiresVisualHydration,
  sourceHydrationTimeout,
} from "./source-catalog.js";
import {
  SOURCE_SESSION_MAX_TABS,
  createSourceSessionObservation,
  sourceSessionStateForTabs,
} from "./session-readiness-policy.js";
import { createSingleFlightSessionPump } from "./background-session-pump.js";
import { captureRequiresVisualHydration } from "./capture-readiness-policy.js";

const AKU_BROWSER_ORIGIN = AKU_BROWSER_LOOPBACK_ORIGIN;
const AKU_BROWSER_ORIGINS = new Set([
  AKU_BROWSER_ORIGIN,
  "http://localhost:11122",
]);
const CAPTURE_DELAY_MAX_MS = 2_000;
const STRUCTURED_MEDIA_COLLECTION_BUDGET_MS = 250;
const STRUCTURED_MEDIA_DELIVERY_WAIT_MS = 400;
const PENDING_SELF_RELOAD_KEY = "akuBridgePendingSelfReload";
const PENDING_SELF_RELOAD_MAX_AGE_MS = 30_000;
const BACKGROUND_DISPATCH_CONFIG_KEY = "akuBridgeBackgroundDispatch";
const BACKGROUND_DISPATCH_ALARM = "akuBridgeBackgroundDispatch";
const BACKGROUND_RELEASE_PUMP_MS = 55_000;
const BACKGROUND_RELEASE_POLL_MS = 650;
let backgroundDispatching = false;
let sourceAccessReconciliation = Promise.resolve();
let installedTabRecoveryQueue = Promise.resolve();
const commandGuard = createCommandGuard();
const nativeRuntimeClient = createChromeNativeRuntimeClient(chrome);
const NATIVE_RUNTIME_BACKGROUND_TIMEOUT_MS = 195_000;
const nativeRuntimeScheduler = createNativeRuntimeScheduler({
  alarms: chrome.alarms,
  storage: chrome.storage.local,
  enabled: nativeRuntimeDistribution(BRIDGE_DEPLOYMENT) === "production",
  check: (trigger) => nativeRuntimeClient.ensureRuntime({
    trigger,
    timeoutMs: NATIVE_RUNTIME_BACKGROUND_TIMEOUT_MS,
  }),
});
const managedCaptureWindow = createManagedCaptureWindowRuntime(chrome);
const readerWindow = createReaderWindowRuntime(chrome);
const xMediaEvidenceStore = createXMediaEvidenceStore(chrome.storage.local);
const xAvatarEvidenceStore = createXAvatarEvidenceStore(chrome.storage.local);
const structuredMediaCollectors = new Map([
  ["x_response", collectXStructuredMediaEvidence],
  ["linkedin_main_world", collectLinkedInStructuredMediaEvidence],
  ["facebook_structured", collectFacebookStructuredMediaEvidence],
  ["instagram_structured", collectInstagramStructuredMediaEvidence],
]);
const SOURCE_SCRIPT_FILES = [
  "bounded-capture-policy.js",
  "capture-quality-policy.js",
  "source-adapter-runtime.js",
  "media-post-processor.js",
  ...sourceRuntimeScripts(),
  "source-freshness-runtime.js",
  "media-acquisition-engine.js",
  "content-script.js",
];
const NATIVE_RUNTIME_DISTRIBUTION = nativeRuntimeDistribution(BRIDGE_DEPLOYMENT);

void resumePendingSelfReload().catch((error) => {
  console.error("AkuBridge could not resume the pending AkuBrowser tab reload.", error);
});
void restoreBackgroundDispatch()
  .then((restored) => {
    if (!restored) return;
    void pollBackgroundDispatch().catch((error) => {
      console.warn("AkuBridge background dispatch startup poll deferred.", error);
    });
  })
  .catch((error) => {
    console.error("AkuBridge could not restore background dispatch configuration.", error);
  });
void nativeRuntimeScheduler.restore().catch(() => {
  console.warn("AkuBridge could not restore the native runtime update schedule.");
});
void resumePendingInstalledAkuBrowserTabRecovery().catch((error) => {
  console.warn("AkuBridge could not resume the pending install tab recovery.", error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AKU_BROWSER_INSTALL_RECOVERY_ALARM) {
    void expireInstalledAkuBrowserTabRecovery().catch((error) => {
      console.warn("AkuBridge could not expire the install tab recovery.", error);
    });
    return;
  }
  if (alarm.name === NATIVE_RUNTIME_CHECK_ALARM) {
    void nativeRuntimeScheduler.checkNow("scheduled_alarm").catch(() => {
      console.warn("AkuBridge could not complete the scheduled native runtime check.");
    });
    return;
  }
  if (alarm.name !== BACKGROUND_DISPATCH_ALARM) return;
  void pollBackgroundDispatch().catch((error) => console.warn("AkuBridge background dispatch deferred.", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  // The event's tab URL may be omitted without the broad `tabs` permission.
  // When it is available, reject foreign pages before touching storage; the
  // recovery query below remains restricted to the two loopback URL patterns.
  if (tab?.url && !isTrustedAkuBrowserTab({ ...tab, id: tabId })) return;
  queueInstalledAkuBrowserTabRecovery(() => recoverPendingInstalledAkuBrowserTabs());
});

chrome.runtime.onInstalled.addListener((details) => {
  const plan = planNativeRuntimeLifecycle("installed", {
    ...details,
    distribution: NATIVE_RUNTIME_DISTRIBUTION,
  });
  if (details.reason === "install") {
    void nativeRuntimeScheduler.scheduleInitial().catch(() => {
      console.warn("AkuBrowser could not schedule the first native runtime update check.");
    });
  }
  void executeNativeRuntimeLifecycle(plan, {
    scheduleNext: details.reason !== "install",
  }).catch(() => {
    console.warn("AkuBrowser could not record native runtime installation state.");
  });
  void beginInstalledAkuBrowserTabRecovery(details).catch((error) => {
    console.warn("AkuBridge could not recover the first AkuBrowser tab after install.", error);
  });
  void scheduleSourceAccessReconciliation().catch(() => {
    console.warn("AkuBrowser could not reconcile approved source access.");
  });
});

chrome.runtime.onStartup.addListener(() => {
  void executeNativeRuntimeLifecycle(planNativeRuntimeLifecycle("startup", {
    distribution: NATIVE_RUNTIME_DISTRIBUTION,
  }), { scheduleNext: true }).catch(() => {
    console.warn("AkuBrowser could not record native runtime startup state.");
  });
  void resumePendingInstalledAkuBrowserTabRecovery().catch((error) => {
    console.warn("AkuBridge could not resume the startup tab recovery.", error);
  });
  void scheduleSourceAccessReconciliation().catch(() => {
    console.warn("AkuBrowser could not reconcile approved source access.");
  });
});

chrome.permissions.onAdded.addListener(() => {
  void reconcileSourceAccessAndRefreshHeartbeat();
});

chrome.permissions.onRemoved.addListener(() => {
  void reconcileSourceAccessAndRefreshHeartbeat();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AKU_BROWSER_RECONCILE_SOURCE_ACCESS") {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, message: "Source access reconciliation rejected." });
      return false;
    }
    reconcileSourceAccessAndRefreshHeartbeat()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_X_AVATAR_EVIDENCE_OBSERVED") {
    if (!isTrustedXSourceContentSender(sender)) {
      sendResponse({ ok: false, message: "X avatar evidence rejected: invalid source tab." });
      return false;
    }
    xAvatarEvidenceStore.put(message.keys, message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_X_AVATAR_EVIDENCE_LOOKUP") {
    if (!isTrustedXSourceContentSender(sender)) {
      sendResponse({ ok: false, message: "X avatar evidence lookup rejected: invalid source tab." });
      return false;
    }
    xAvatarEvidenceStore.lookup(message.keys)
      .then((evidence) => sendResponse({ ok: true, evidence }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_X_MEDIA_EVIDENCE_OBSERVED") {
    if (!isTrustedXSourceContentSender(sender)) {
      sendResponse({ ok: false, message: "X media evidence rejected: invalid source tab." });
      return false;
    }
    xMediaEvidenceStore.put(message.candidateId, message.media)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BROWSER_X_MEDIA_EVIDENCE_LOOKUP") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "X media evidence lookup rejected: invalid AkuBrowser origin." });
      return false;
    }
    xMediaEvidenceStore.lookup(message.candidateIds)
      .then((evidence) => sendResponse({ ok: true, evidence }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_GET_CAPABILITIES") {
    bridgeCapabilitiesWithSourceAccess()
      .then((capabilities) => sendResponse({ ok: true, capabilities }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_PROBE_SOURCE_SESSIONS") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Source session probe rejected: invalid AkuBrowser origin." });
      return false;
    }
    probeSourceSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_OPEN_SOURCE") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Open source rejected: invalid AkuBrowser origin." });
      return false;
    }
    openSourceFeed(message.source)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_OPEN_NATIVE_POST") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Open native post rejected: invalid AkuBrowser origin." });
      return false;
    }
    openNativePostInReaderWindow(message.source, message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_REVOKE_SOURCE_ACCESS") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Revoke rejected: invalid AkuBrowser origin." });
      return false;
    }
    revokeAllSourceAccess(chrome)
      .then((state) => sendResponse({ ok: true, grantedSources: state?.grantedSources ?? [] }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_CONFIGURE_BACKGROUND_DISPATCH") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Background dispatch configuration rejected: invalid AkuBrowser origin." });
      return false;
    }
    configureBackgroundDispatch(message.endpoint, message.token, message.protocolMajor)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_RELOAD_SELF") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ accepted: false, message: "reload_self rejected: invalid AkuBrowser origin." });
      return false;
    }
    acceptReloadSelf(message, sender.tab?.id)
      .then(() => {
        sendResponse({ accepted: true });
        chrome.runtime.reload();
      })
      .catch((error) => sendResponse({
        accepted: false,
        message: String(error?.message ?? error),
      }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_RELEASE_CAPTURE_SURFACE") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Capture-surface release rejected: invalid AkuBrowser origin." });
      return false;
    }
    releaseCaptureSurfaceWithTelemetry(message)
      .then((outcome) => sendResponse({ ok: true, outcome }))
      .catch((error) => sendResponse({
        ok: false,
        message: String(error?.message ?? error),
      }));
    return true;
  }
  if (message?.type === "AKU_BRIDGE_MEDIA_RECAPTURE") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Media recapture rejected: invalid AkuBrowser origin." });
      return false;
    }
    dispatchMediaRecapture(message)
      .then((recapture) => sendResponse({ ok: true, recapture }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "AKU_BROWSER_CAPTURE_DELAY") {
    if (!isTrustedSourceContentSender(sender)) {
      sendResponse({ ok: false, message: "Capture delay rejected: invalid source tab." });
      return false;
    }
    const milliseconds = Math.max(
      0,
      Math.min(CAPTURE_DELAY_MAX_MS, Math.trunc(Number(message.milliseconds) || 0)),
    );
    setTimeout(() => sendResponse({ ok: true }), milliseconds);
    return true;
  }
  if (message?.type === "AKU_LINKEDIN_COLLECT_STRUCTURED_MEDIA") {
    if (!isTrustedSourceContentSender(sender) || sourceForUrl(sender.url) !== "linkedin") {
      sendResponse({ ok: false, message: "LinkedIn media collection rejected: invalid source tab." });
      return false;
    }
    collectLinkedInStructuredMediaEvidence(sender.tab.id, {
      candidateIds: message.candidateIds,
      playerIds: message.playerIds,
    })
      .then((evidence) => sendResponse({ ok: true, evidence }))
      .catch((error) => sendResponse({
        ok: false,
        message: String(error?.message ?? error).slice(0, 300),
      }));
    return true;
  }
  if (message?.type !== "AKU_BROWSER_DISPATCH") return undefined;
  if (!isAkuBrowserOrigin(sender.url)) {
    sendResponse({ ok: false, message: "Dispatch rejected: invalid AkuBrowser origin." });
    return false;
  }
  dispatchRun(message)
    .then(() => {
      void queueBackgroundSessionPump(message.endpoint, message.token).catch((error) => {
        console.warn("AkuBridge session pump deferred after page dispatch.", error);
      });
      return bridgeCapabilitiesWithSourceAccess();
    })
    .then((capabilities) => sendResponse({ ok: true, capabilities }))
    .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
  return true;
});

function queueInstalledAkuBrowserTabRecovery(task) {
  installedTabRecoveryQueue = installedTabRecoveryQueue
    .catch(() => undefined)
    .then(task);
  return installedTabRecoveryQueue;
}

async function beginInstalledAkuBrowserTabRecovery(details = {}) {
  if (!shouldRecoverInstalledAkuBrowserTabs({
    mode: BRIDGE_DEPLOYMENT.mode,
    reason: details.reason,
  })) return;

  const version = String(chrome.runtime.getManifest().version);
  const existing = (await chrome.storage.local.get(AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY))?.[
    AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY
  ];
  const state = existing?.eventKey === `${details.reason}:${version}` &&
    isCurrentInstalledAkuBrowserTabRecovery(existing)
    ? existing
    : createInstalledAkuBrowserTabRecovery({ reason: details.reason, version });
  await chrome.storage.local.set({ [AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY]: state });
  await chrome.alarms.create(AKU_BROWSER_INSTALL_RECOVERY_ALARM, { when: state.expiresAt });
  await queueInstalledAkuBrowserTabRecovery(() => recoverPendingInstalledAkuBrowserTabs());
}

async function resumePendingInstalledAkuBrowserTabRecovery() {
  await queueInstalledAkuBrowserTabRecovery(() => recoverPendingInstalledAkuBrowserTabs());
}

async function recoverPendingInstalledAkuBrowserTabs() {
  const state = (await chrome.storage.local.get(AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY))?.[
    AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY
  ];
  if (!state) return;
  if (!isCurrentInstalledAkuBrowserTabRecovery(state)) {
    await clearInstalledAkuBrowserTabRecovery();
    return;
  }
  if (!shouldRecoverInstalledAkuBrowserTabs({
    mode: BRIDGE_DEPLOYMENT.mode,
    reason: state.reason,
  })) {
    await clearInstalledAkuBrowserTabRecovery();
    return;
  }

  const tabs = await chrome.tabs.query({ url: AKU_BROWSER_LOOPBACK_URL_PATTERNS });
  const attemptedTabIds = Array.isArray(state.attemptedTabIds)
    ? state.attemptedTabIds.filter((tabId) => Number.isInteger(tabId))
    : [];
  const remainingTabSlots = AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS - attemptedTabIds.length;
  if (remainingTabSlots <= 0) return;
  const candidates = selectInstalledAkuBrowserTabs(tabs, {
    ...state,
    limit: remainingTabSlots,
  });
  if (candidates.length === 0) return;

  for (const tab of candidates) {
    if (attemptedTabIds.includes(tab.id)) continue;
    const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!isTrustedAkuBrowserTab(currentTab) ||
      (currentTab.status !== undefined && currentTab.status !== "complete")) continue;
    attemptedTabIds.push(tab.id);
    await chrome.storage.local.set({
      [AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY]: {
        ...state,
        attemptedTabIds: [...attemptedTabIds],
      },
    });
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        world: "ISOLATED",
        files: [AKU_BROWSER_TAB_BRIDGE_FILE],
      });
      const origin = new URL(currentTab.url).origin;
      const ping = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        world: "ISOLATED",
        func: postAkuBrowserBridgePing,
        args: [origin],
      });
      if (ping?.[0]?.result !== true) {
        throw new Error("AkuBridge relay ping was rejected by the trusted tab origin.");
      }
    } catch (error) {
      console.warn(`AkuBridge could not install the relay in trusted AkuBrowser tab ${tab.id}.`, error);
    }
  }
}

function postAkuBrowserBridgePing(expectedOrigin) {
  if (window.location.origin !== expectedOrigin) return false;
  window.postMessage({
    type: "AKU_BROWSER_BRIDGE_PING",
    protocolMajor: 2,
    protocolMinor: 0,
  }, expectedOrigin);
  return true;
}

async function expireInstalledAkuBrowserTabRecovery() {
  const state = (await chrome.storage.local.get(AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY))?.[
    AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY
  ];
  if (!state || !isCurrentInstalledAkuBrowserTabRecovery(state)) {
    await clearInstalledAkuBrowserTabRecovery();
  }
}

async function clearInstalledAkuBrowserTabRecovery() {
  await chrome.storage.local.remove(AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY);
  await chrome.alarms.clear(AKU_BROWSER_INSTALL_RECOVERY_ALARM);
}

function isTrustedSourceContentSender(sender) {
  if (!Number.isInteger(sender.tab?.id) || typeof sender.url !== "string") return false;
  return sourceForUrl(sender.url) !== null;
}

function isAkuBrowserOrigin(value) {
  try {
    return AKU_BROWSER_ORIGINS.has(new URL(value).origin);
  } catch {
    return false;
  }
}

function isTrustedXSourceContentSender(sender) {
  if (!isTrustedSourceContentSender(sender)) return false;
  return sourceDefinition(sourceForUrl(sender.url))?.structuredMediaCollector === "x_response";
}

async function acceptReloadSelf(message, akuBrowserTabId) {
  assertEndpoint(message.endpoint);
  if (typeof message.actionId !== "string" || !message.actionId) {
    throw new Error("reload_self requires an action ID.");
  }
  if (!Number.isInteger(akuBrowserTabId)) {
    throw new Error("reload_self requires the originating AkuBrowser tab ID.");
  }
  await chrome.storage.local.set({
    [PENDING_SELF_RELOAD_KEY]: {
      tabId: akuBrowserTabId,
      requestedAt: Date.now(),
    },
  });
  try {
    const response = await fetch(
      `${message.endpoint}/api/operations/bridge/actions/${encodeURIComponent(message.actionId)}/accept`,
      {
        method: "POST",
        headers: bridgeHeaders(message.token),
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || `reload_self acceptance failed with ${response.status}.`);
    }
  } catch (error) {
    await chrome.storage.local.remove(PENDING_SELF_RELOAD_KEY);
    throw error;
  }
}

async function resumePendingSelfReload() {
  const stored = await chrome.storage.local.get(PENDING_SELF_RELOAD_KEY);
  const pending = stored[PENDING_SELF_RELOAD_KEY];
  if (!pending) return;
  if (
    !Number.isInteger(pending.tabId) ||
    !Number.isFinite(pending.requestedAt) ||
    Date.now() - pending.requestedAt > PENDING_SELF_RELOAD_MAX_AGE_MS
  ) {
    await chrome.storage.local.remove(PENDING_SELF_RELOAD_KEY);
    return;
  }
  const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
  if (!isTrustedAkuBrowserTab(tab)) {
    await chrome.storage.local.remove(PENDING_SELF_RELOAD_KEY);
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    files: [AKU_BROWSER_TAB_BRIDGE_FILE],
  });
  const origin = new URL(tab.url).origin;
  const ping = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: postAkuBrowserBridgePing,
    args: [origin],
  });
  if (ping?.[0]?.result !== true) {
    throw new Error("AkuBridge post-reload relay ping was rejected by the trusted tab origin.");
  }
  await chrome.storage.local.remove(PENDING_SELF_RELOAD_KEY);
}

async function dispatchRun(message) {
  assertEndpoint(message.endpoint);
  const command = await claimCommand(message.endpoint, message.token, message.runId);
  if (!command) throw new Error("No queued browser command was available for this run.");
  if (!commandGuard.begin(command.id)) {
    throw new AkuBridgeError("duplicate_command", "dispatch", `AkuBridge rejected duplicate command ${command.id}.`);
  }

  try {
    if (typeof command.payload.captureLeaseId === "string") {
      await rememberBackgroundLease(message.endpoint, message.token, command.payload.captureLeaseId);
    }
    if (command.type !== "collect_visible") {
      throw new Error(`Unsupported browser command: ${command.type}.`);
    }
    if (command.payload.browserAdapter !== "aku-bridge") {
      throw new Error("The browser command targeted an unsupported adapter.");
    }
    const observation = await captureWithSourceTabRecovery(command);
    await postBridgeResult(
      message.endpoint,
      message.token,
      command.id,
      "observation",
      { runId: message.runId, observation },
    );
    await postCaptureSurfaceEvents(
      message.endpoint,
      message.token,
      command.payload.captureLeaseId,
      message.runId,
      command.payload.source,
      observation.coverage?.captureSurfaceLifecycle ?? [],
    ).catch(() => undefined);
    commandGuard.finish(command.id);
  } catch (error) {
    await postCaptureSurfaceEvents(
      message.endpoint,
      message.token,
      command.payload.captureLeaseId,
      message.runId,
      command.payload.source,
      error?.captureSurfaceLifecycle ?? [],
    ).catch(() => undefined);
    await postBridgeResult(
      message.endpoint,
      message.token,
      command.id,
      "failure",
      { runId: message.runId, error: serializeBridgeError(error) },
    ).catch(() => undefined);
    commandGuard.finish(command.id);
    throw error;
  }
}

async function observeNativeRuntime(trigger) {
  const outcome = await nativeRuntimeClient.ensureRuntime({ trigger });
  if (outcome.state === "runtime_failed") {
    console.warn("AkuBrowser native runtime check failed.", outcome.errorCode);
  }
  return outcome;
}

async function inspectNativeRuntime(trigger) {
  return nativeRuntimeClient.status({ trigger });
}

async function reconcileNativeRuntime(trigger) {
  return nativeRuntimeClient.reconcileRuntime({ trigger });
}

async function executeNativeRuntimeLifecycle(plan, { scheduleNext = false } = {}) {
  if (plan.action === "none") return null;
  if (scheduleNext && plan.action === "ensure_runtime") {
    return nativeRuntimeScheduler.checkNow(plan.trigger);
  }
  if (plan.action === "status") {
    return inspectNativeRuntime(plan.trigger);
  }
  if (plan.action === "reconcile_runtime") {
    return reconcileNativeRuntime(plan.trigger);
  }
  return observeNativeRuntime(plan.trigger);
}

function scheduleSourceAccessReconciliation() {
  sourceAccessReconciliation = sourceAccessReconciliation
    .catch(() => undefined)
    .then(() => reconcileRegisteredSourceScripts(chrome));
  return sourceAccessReconciliation;
}

async function reconcileSourceAccessAndRefreshHeartbeat() {
  const state = await scheduleSourceAccessReconciliation();
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY).catch(() => ({}));
  const config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (config) await refreshBackgroundHeartbeat(config).catch(() => undefined);
  return state;
}

function isTrustedExtensionPage(sender) {
  const extensionOrigin = chrome.runtime.getURL("");
  return sender?.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(extensionOrigin);
}

async function rememberBackgroundLease(endpoint, token, leaseId) {
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const current = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (!current || current.endpoint !== endpoint || current.token !== token) return;
  const next = { ...current, activeLeaseId: leaseId };
  if (current.activeLeaseId !== leaseId) next.releasedSources = [];
  await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
}

async function releaseTerminalBackgroundLease(config) {
  if (typeof config.activeLeaseId !== "string" || !config.activeLeaseId) return config;
  const response = await fetch(
    `${config.endpoint}/api/sessions/${encodeURIComponent(config.activeLeaseId)}`,
    { headers: bridgeHeaders(config.token), cache: "no-store" },
  );
  if (response.status === 401 || response.status === 403) {
    await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
    await chrome.alarms.clear(BACKGROUND_DISPATCH_ALARM);
    return null;
  }
  let terminal = response.status === 404;
  let session = null;
  if (response.ok) {
    session = (await response.json()).session;
    terminal = ["completed", "partial", "failed", "cancelled"].includes(session?.status);
  } else if (!terminal) {
    throw new Error(await responseError(response, "Could not inspect background session lifecycle"));
  }
  const releasedSources = new Set(Array.isArray(config.releasedSources) ? config.releasedSources : []);
  if (session?.runs && typeof config.activeLeaseId === "string") {
    for (const run of session.runs) {
      if (!sourceIds().includes(run?.source) || !sourceCaptureSurfaceReleasable(run) || releasedSources.has(run.source)) continue;
      await postCaptureSurfaceEvents(
        config.endpoint,
        config.token,
        config.activeLeaseId,
        run.id,
        run.source,
        [captureSurfaceEvent("release_requested", run.source, {
          outcome: "source_acquisition_closed",
        })],
      ).catch(() => undefined);
      const outcome = await managedCaptureWindow.releaseSource(run.source, config.activeLeaseId).catch(() => null);
      await postCaptureSurfaceEvents(
        config.endpoint,
        config.token,
        config.activeLeaseId,
        run.id,
        run.source,
        outcome?.events ?? [],
      ).catch(() => undefined);
      if (outcome && outcome.reason !== "lease_mismatch") releasedSources.add(run.source);
    }
  }
  if (!terminal) {
    const next = { ...config, releasedSources: [...releasedSources] };
    await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
    return next;
  }
  const terminalOutcome = await managedCaptureWindow.release(config.activeLeaseId).catch(() => null);
  await postCaptureSurfaceEvents(
    config.endpoint,
    config.token,
    config.activeLeaseId,
    "",
    null,
    terminalOutcome?.events ?? [],
  ).catch(() => undefined);
  const next = { ...config };
  delete next.activeLeaseId;
  delete next.releasedSources;
  await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
  return next;
}

async function refreshBackgroundHeartbeat(config) {
  const currentCapabilities = await bridgeCapabilitiesWithSourceAccess();
  const capabilities = bridgeCapabilitiesForProtocol(
    currentCapabilities,
    config.sidecarProtocolMajor,
  );
  const response = await fetch(`${config.endpoint}/api/bridge/heartbeat`, {
    method: "POST",
    headers: { ...bridgeHeaders(config.token), "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities }),
  });
  if (response.status === 401 || response.status === 403) {
    await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
    await chrome.alarms.clear(BACKGROUND_DISPATCH_ALARM);
    return false;
  }
  if (!response.ok) throw new Error(await responseError(response, "Could not refresh background Bridge heartbeat"));
  return true;
}

async function configureBackgroundDispatch(endpoint, token, protocolMajor = 0) {
  assertEndpoint(endpoint);
  if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new Error("Background dispatch requires a valid Bridge token.");
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const current = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  const next = {
    endpoint,
    token,
    sidecarProtocolMajor: protocolMajor === 2 ? 2 : 0,
  };
  if (current?.endpoint === endpoint && current?.token === token && typeof current.activeLeaseId === "string") {
    next.activeLeaseId = current.activeLeaseId;
    next.releasedSources = Array.isArray(current.releasedSources)
      ? current.releasedSources
      : [];
  }
  await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
  await chrome.alarms.create(BACKGROUND_DISPATCH_ALARM, { periodInMinutes: 1 });
  await pollBackgroundDispatch();
}

async function restoreBackgroundDispatch() {
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (!config) return false;
  try {
    assertEndpoint(config.endpoint);
    if (typeof config.token !== "string" || config.token.length < 32) throw new Error("invalid stored token");
  } catch {
    await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
    return false;
  }
  const reconciliation = await managedCaptureWindow.reconcile();
  if (typeof config.activeLeaseId === "string") {
    await postCaptureSurfaceEvents(
      config.endpoint,
      config.token,
      config.activeLeaseId,
      "",
      null,
      reconciliation.events ?? [],
    ).catch(() => undefined);
  }
  await chrome.alarms.create(BACKGROUND_DISPATCH_ALARM, { periodInMinutes: 1 });
  return true;
}

async function pollBackgroundDispatch() {
  if (backgroundDispatching) return;
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  let config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (!config) return;
  backgroundDispatching = true;
  try {
    let heartbeatReady;
    try {
      heartbeatReady = await refreshBackgroundHeartbeat(config);
    } catch (error) {
      throw backgroundDispatchStageError("heartbeat_refresh", error);
    }
    if (!heartbeatReady) return;
    try {
      config = await releaseTerminalBackgroundLease(config);
    } catch (error) {
      throw backgroundDispatchStageError("lease_reconciliation", error);
    }
    if (!config) return;
    let response;
    try {
      response = await fetch(`${config.endpoint}/api/bridge/commands/pending`, {
        headers: bridgeHeaders(config.token),
        cache: "no-store",
      });
    } catch (error) {
      throw backgroundDispatchStageError("pending_command_poll", error);
    }
    if (response.status === 204) return;
    if (response.status === 401 || response.status === 403) {
      await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
      await chrome.alarms.clear(BACKGROUND_DISPATCH_ALARM);
      return;
    }
    if (!response.ok) throw new Error(await responseError(response, "Could not inspect pending background command"));
    const runId = (await response.json()).runId;
    if (typeof runId !== "string" || !runId) return;
    try {
      await dispatchRun({ endpoint: config.endpoint, token: config.token, runId, background: true });
      await queueBackgroundSessionPump(config.endpoint, config.token);
    } catch (error) {
      if (error?.message === "No queued browser command was available for this run.") return;
      console.error("AkuBridge background command failed.", error);
    }
  } finally {
    backgroundDispatching = false;
  }
}

function backgroundDispatchStageError(stage, error) {
  return new AkuBridgeError(
    "background_dispatch_deferred",
    "background_dispatch",
    `AkuBridge background dispatch ${stage} failed: ${String(error?.message ?? error).slice(0, 240)}`,
    { stage },
  );
}

async function pumpBackgroundSession(endpoint, token) {
  const deadline = Date.now() + BACKGROUND_RELEASE_PUMP_MS;
  while (Date.now() < deadline) {
    const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
    let config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
    if (!config || config.endpoint !== endpoint || config.token !== token) return;
    config = await releaseTerminalBackgroundLease(config);
    if (!config?.activeLeaseId) return;
    const response = await fetch(
      `${config.endpoint}/api/bridge/commands/pending`,
      { headers: bridgeHeaders(config.token), cache: "no-store" },
    );
    if (response.status === 204) {
      await delay(BACKGROUND_RELEASE_POLL_MS);
      continue;
    }
    if (!response.ok) return;
    const runId = (await response.json()).runId;
    if (typeof runId === "string" && runId) {
      await dispatchRun({
        endpoint: config.endpoint,
        token: config.token,
        runId,
        background: true,
      });
    }
  }
}

const queueBackgroundSessionPump = createSingleFlightSessionPump(pumpBackgroundSession);

async function releaseCaptureSurfaceWithTelemetry(message) {
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  const leaseId = typeof message?.leaseId === "string" ? message.leaseId : "";
  const source = sourceIds().includes(message?.source) ? message.source : null;
  const canReport = Boolean(
    config &&
    typeof config.endpoint === "string" &&
    typeof config.token === "string" &&
    leaseId,
  );
  if (canReport && source) {
    await postCaptureSurfaceEvents(
      config.endpoint,
      config.token,
      leaseId,
      "",
      source,
      [captureSurfaceEvent("release_requested", source, {
        outcome: "timeline_source_acquisition_closed",
      })],
    ).catch(() => undefined);
  }
  const outcome = source
    ? await managedCaptureWindow.releaseSource(source, leaseId)
    : await managedCaptureWindow.release(leaseId);
  if (canReport) {
    await postCaptureSurfaceEvents(
      config.endpoint,
      config.token,
      leaseId,
      "",
      source,
      outcome?.events ?? [],
    ).catch(() => undefined);
  }
  return outcome;
}

async function postCaptureSurfaceEvents(
  endpoint,
  token,
  sessionId,
  runId,
  fallbackSource,
  events,
) {
  if (
    typeof endpoint !== "string" ||
    typeof token !== "string" ||
    typeof sessionId !== "string" ||
    !sessionId ||
    !Array.isArray(events) ||
    events.length === 0
  ) return;
  const payload = events.flatMap((event) => {
    const source = sourceIds().includes(event?.source)
      ? event.source
      : sourceIds().includes(fallbackSource)
        ? fallbackSource
        : null;
    if (typeof event?.event !== "string") return [];
    return [{
      id: createCaptureSurfaceEventId(),
      sessionId,
      runId: typeof runId === "string" ? runId : "",
      source,
      event: event.event,
      outcome: String(event.outcome ?? event.detail?.outcome ?? "").slice(0, 120),
      detail: event.detail && typeof event.detail === "object"
        ? event.detail
        : {},
      occurredAt: typeof event.occurredAt === "string"
        ? event.occurredAt
        : new Date().toISOString(),
    }];
  });
  if (payload.length === 0) return;
  const response = await fetch(`${endpoint}/api/bridge/capture-surfaces/events`, {
    method: "POST",
    headers: {
      ...bridgeHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events: payload }),
  });
  if (!response.ok) {
    throw new Error(await responseError(response, "Could not record capture-surface telemetry"));
  }
}

function captureSurfaceEvent(event, source, detail = {}) {
  return {
    event,
    source: sourceIds().includes(source) ? source : null,
    outcome: String(detail.outcome ?? "").slice(0, 120),
    detail: { ...detail },
    occurredAt: new Date().toISOString(),
  };
}

function createCaptureSurfaceEventId() {
  if (typeof crypto?.randomUUID === "function") {
    return `capture_surface_${crypto.randomUUID()}`;
  }
  return `capture_surface_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

async function dispatchMediaRecapture(message) {
  assertEndpoint(message.endpoint);
  if (typeof message.recaptureId !== "string" || !message.recaptureId) {
    throw new Error("Media recapture requires a job ID.");
  }
  const response = await fetch(
    `${message.endpoint}/api/bridge/media-recaptures/${encodeURIComponent(message.recaptureId)}/claim`,
    { headers: bridgeHeaders(message.token), cache: "no-store" },
  );
  if (!response.ok) throw new Error(await responseError(response, "Could not claim media recapture"));
  const recapture = (await response.json()).recapture;
  if (!commandGuard.begin(recapture.id)) {
    throw new AkuBridgeError("duplicate_command", "media_recapture", `AkuBridge rejected duplicate recapture ${recapture.id}.`);
  }
  try {
    const targetUrl = assertRecaptureTarget(recapture.source, recapture.targetUrl);
    const observation = await captureWithSourceTabRecovery({
      id: recapture.id,
      type: "recapture_media",
      payload: { ...recapture.payload, targetUrl },
    });
    const completed = await postMediaRecaptureResult(
      message.endpoint,
      message.token,
      recapture.id,
      "observation",
      { observation },
    );
    commandGuard.finish(recapture.id);
    return completed.recapture;
  } catch (error) {
    await postMediaRecaptureResult(
      message.endpoint,
      message.token,
      recapture.id,
      "failure",
      { error: serializeBridgeError(error) },
    ).catch(() => undefined);
    commandGuard.finish(recapture.id);
    throw error;
  } finally {
    await managedCaptureWindow.release(recapture.id).catch(() => undefined);
  }
}

async function captureWithSourceTabRecovery(command) {
  if (!await sourceAccessGranted(chrome, command.payload.source)) {
    throw new AkuBridgeError(
      "source_permission_required",
      "source_access",
      `AkuBrowser source access is not enabled for ${command.payload.source}.`,
      { source: command.payload.source },
    );
  }
  for (let attempt = 0; ; attempt += 1) {
    let prepared = null;
    try {
      prepared = await findOrOpenSourceTab(
        command.payload.source,
        command.payload.mode,
        command.payload.openIfMissing,
        command.payload.captureVisibilityPolicy,
        command.payload.captureLeaseId,
        command.payload.targetUrl,
        command.payload.foregroundAuthorized === true,
        command.payload.sourceHydrationTimeoutMs,
        command.payload.acquisitionRound,
      );
      const observation = await capturePreparedSource(command, prepared, attempt);
      if (observationEvidenceBlockCount(observation) === 0) {
        throw new AkuBridgeError(
          "capture_empty",
          "capture",
          `AkuBridge found no usable ${command.payload.source} evidence after the bounded capture.`,
          emptyCaptureDiagnostics(observation),
        );
      }
      if (shouldCloseOpenedSourceTab({
        opened: prepared.opened,
        lifecycle: command.payload.tabLifecycle,
        captureCompleted: true,
      })) {
        await chrome.tabs.remove(prepared.tab.id).catch(() => undefined);
        prepared.closed = true;
        observation.coverage.sourceTabClosedAfterCapture = true;
      }
      const focusOutcome = await prepared.restoreFocus();
      observation.coverage.captureVisibilityPolicy = prepared.captureVisibilityPolicy;
      observation.coverage.captureVisibilityMode = prepared.captureVisibilityMode;
      // Tab preservation is an ownership guarantee, not a focus snapshot.
      // A user may intentionally move focus while capture is running, and
      // Chrome may briefly report the managed window as last-focused. Neither
      // event means that AkuBridge navigated or closed the user's working tab.
      observation.coverage.workingTabPreserved = prepared.workingTabPreserved === true;
      observation.coverage.workingFocusRestored = focusOutcome.restored === true;
      observation.coverage.captureSurfaceLifecycle = prepared.lifecycleEvents ?? [];
      return observation;
    } catch (error) {
      const sourcePolicy = sourceDefinition(command.payload.source);
      const retry = shouldRetrySourceTab({
        error,
        acquisitionRound: command.payload.acquisitionRound ?? 1,
        attempt,
        ownership: prepared?.ownership ?? null,
        emptyObservationRecovery: sourcePolicy?.captureRecovery?.emptyObservation ?? null,
      });
      if (!retry) {
        if (prepared?.lifecycleEvents?.length) {
          error.captureSurfaceLifecycle = prepared.lifecycleEvents;
        }
        throw error;
      }
      if (error?.code === "capture_empty" && prepared?.ownership === "managed") {
        await chrome.tabs.reload(prepared.tab.id);
        await waitForTabComplete(prepared.tab.id, 20_000);
      }
    } finally {
      if (prepared) {
        await prepared.restoreFocus();
        if (prepared.closeOnExit && !prepared.closed) {
          await chrome.tabs.remove(prepared.tab.id).catch(() => undefined);
          prepared.closed = true;
        }
      }
    }
  }
}

async function capturePreparedSource(command, prepared, sourceTabRecoveryCount) {
  await assertTabLease(prepared.lease, "before_capture");
  if (prepared.structuredFeedFallback) {
    await assertTabLease(prepared.lease, "after_capture");
    prepared.structuredFeedFallback.coverage.structuredFeedFallback =
      prepared.structuredFeedDiagnostics ?? null;
    return prepared.structuredFeedFallback;
  }
  const captureSurface = await inspectCaptureSurface(chrome, prepared.tab.id);
  const tabLifecycle = normalizeSourceTabLifecycle(command.payload.tabLifecycle);
  const sourceFreshness = await recoverSourceFreshness({
    source: command.payload.source,
    acquisitionRound: command.payload.acquisitionRound ?? 1,
    backgroundAtDispatch: prepared.freshnessBackgroundAtDispatch ?? prepared.backgroundAtDispatch,
    opened: prepared.opened,
    activatedBeforeRecovery: prepared.activatedForReadiness,
    pendingContentPolicy: command.payload.pendingContentPolicy,
    sameTabMutationAllowed: command.payload.sameTabMutationAllowed,
    activate: prepared.activateForRetry,
    probe: () => probeSourceFreshness(prepared.tab.id, command.payload.source),
    reveal: () => revealPendingSourceContent(prepared.tab.id, command.payload),
  });
  const sourcePolicy = sourceDefinition(command.payload.source);
  const structuredCollector = structuredMediaCollectors.get(sourcePolicy?.structuredMediaCollector);
  const structuredMediaRequestId = structuredCollector
    ? `${command.id}:${sourceTabRecoveryCount}`
    : null;
  const payload = {
    ...command.payload,
    sourceFreshness,
    ...(structuredMediaRequestId ? {
      structuredMediaRequest: {
        requestId: structuredMediaRequestId,
        waitMs: STRUCTURED_MEDIA_DELIVERY_WAIT_MS,
        mode: "parallel_deferred",
      },
    } : {}),
    sourceReadiness: prepared.readiness,
    tabAcquisition: {
      opened: prepared.opened,
      activatedForReadiness: prepared.activatedForReadiness,
      backgroundAtDispatch: prepared.backgroundAtDispatch,
      recoveryCount: sourceTabRecoveryCount,
      ownership: prepared.ownership,
      openedTabDisposition:
        prepared.openedTabDisposition ?? tabLifecycle.openedTabDisposition,
      captureVisibilityPolicy: prepared.captureVisibilityPolicy,
      captureVisibilityMode: prepared.captureVisibilityMode,
      captureSurface,
    },
  };
  const response = structuredCollector
    ? (await captureWithParallelStructuredMedia({
        capture: () => collectFromTabWithDeadline(prepared.tab.id, payload),
        collect: () => collectStructuredMediaWithinBudget({
          collector: structuredCollector,
          tabId: prepared.tab.id,
          budgetMs: STRUCTURED_MEDIA_COLLECTION_BUDGET_MS,
        }),
        deliver: (evidence) => deliverStructuredMediaEvidence(
          prepared.tab.id,
          structuredMediaRequestId,
          evidence,
        ),
      })).response
    : await collectFromTabWithDeadline(prepared.tab.id, payload);
  if (!response?.ok) throw new Error(response?.message || "Source content script failed.");
  await assertTabLease(prepared.lease, "after_capture");
  return response.observation;
}

async function collectXStructuredMediaEvidence(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resolveXStructuredMediaInMainWorld,
      args: [{
        maxCandidates: 16,
        maxMediaPerCandidate: 4,
        maxTraversalNodes: 1_500,
        maxDepth: 9,
      }],
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    return {
      runtimeRevision: "x-main-world-media-resolver-v1",
      resolverVersion: "x-structured-media-v1",
      candidates: [],
      diagnostics: {
        status: "unavailable",
        reason: String(error?.message ?? error).slice(0, 300),
      },
    };
  }
}

async function claimCommand(endpoint, token, runId) {
  const response = await fetch(
    `${endpoint}/api/bridge/commands/next?runId=${encodeURIComponent(runId)}`,
    {
      headers: bridgeHeaders(token),
      cache: "no-store",
    },
  );
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(await responseError(response, "Could not claim bridge command"));
  return (await response.json()).command;
}

async function postBridgeResult(endpoint, token, commandId, kind, payload) {
  const response = await fetch(
    `${endpoint}/api/bridge/commands/${encodeURIComponent(commandId)}/${kind}`,
    {
      method: "POST",
      headers: { ...bridgeHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) throw new Error(await responseError(response, `Could not submit ${kind}`));
}

async function postMediaRecaptureResult(endpoint, token, id, kind, payload) {
  const response = await fetch(
    `${endpoint}/api/bridge/media-recaptures/${encodeURIComponent(id)}/${kind}`,
    {
      method: "POST",
      headers: { ...bridgeHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) throw new Error(await responseError(response, `Could not submit media recapture ${kind}`));
  return response.json();
}

function bridgeHeaders(token) {
  return {
    "X-Aku-Bridge-Token": token,
    "X-Aku-Bridge-Id": BRIDGE_ID,
    "X-Aku-Bridge-Contract": BRIDGE_CONTRACT_VERSION,
  };
}

async function findOrOpenSourceTab(
  source,
  mode,
  openIfMissing,
  requestedVisibilityPolicy,
  captureLeaseId,
  targetUrl = null,
  foregroundAuthorized = false,
  requestedHydrationTimeoutMs = null,
  acquisitionRound = 1,
) {
  const visibilityPlan = planCaptureVisibility({
    policy: requestedVisibilityPolicy,
    mode,
    foregroundAuthorized,
  });
  const requireVisualHydration = captureRequiresVisualHydration({
    source,
    acquisitionRound,
    targetUrl,
    foregroundAuthorized: visibilityPlan.foregroundAuthorized,
  });
  const readyReusable = visibilityPlan.initialMode === "managed_window" && !targetUrl
    ? await findReadyReusableSourceTab(source)
    : null;
  if (readyReusable) {
    return prepareSourceTab(readyReusable.tab, source, false, {
      ownership: "shared",
      captureVisibilityPolicy: visibilityPlan.policy,
      captureVisibilityMode: "ready_inactive_canonical_tab",
      workingTabPreserved: true,
      openedTabDisposition: "preserve",
      hydrationTimeoutMs: requestedHydrationTimeoutMs,
      requireVisualHydration,
      prevalidatedReadiness: readyReusable.readiness,
      passiveReadyReuse: true,
      lifecycleEvents: [captureSurfaceEvent("reused", source, {
        outcome: "ready_inactive_canonical_tab",
      })],
    });
  }
  let targetCaptureTabId = null;
  if (visibilityPlan.initialMode === "managed_window") {
    let managed = null;
    let managedLoadAttempt = 0;
    const managedLifecycleEvents = [];
    try {
      while (true) {
        managed = await managedCaptureWindow.prepare(source, {
          openIfMissing,
          leaseId: captureLeaseId,
          windowIsolation: visibilityPlan.windowIsolation,
        });
        managedLifecycleEvents.push(...(managed.lifecycleEvents ?? []));
        managed.lifecycleEvents.splice(
          0,
          managed.lifecycleEvents.length,
          ...managedLifecycleEvents,
        );
        try {
          if (managed.opened || managed.reset) {
            const navigation = await waitForTabComplete(managed.tab.id, 20_000, {
              source,
              phase: managed.reset ? "canonical_feed_reset" : "managed_surface_created",
            });
            if (navigation.reason === "source_ready") {
              managedLifecycleEvents.push(captureSurfaceEvent("reconciled", source, {
                outcome: "navigation_source_ready",
                elapsedMs: navigation.elapsedMs,
                tabStatus: navigation.tabStatus,
              }));
            }
          }
          if (!targetUrl) {
            const prepared = await prepareSourceTab(
              managed.tab,
              source,
              managed.opened,
              {
                ownership: "managed",
                captureVisibilityPolicy: visibilityPlan.policy,
                captureVisibilityMode: "managed_window",
                workingTabPreserved: true,
                openedTabDisposition: "close_after_session",
                requireVisualHydration,
                restoreFocus: managed.verifyFocus,
                hydrationTimeoutMs: requestedHydrationTimeoutMs,
                lifecycleEvents: managed.lifecycleEvents,
              },
            );
            prepared.closeOnExit = false;
            return prepared;
          }
          break;
        } catch (error) {
          const recoveryPolicy = sourceDefinition(source)?.captureRecovery;
          const adapterRecovery = error?.details?.readiness?.recoveryHint ?? null;
          if (!shouldRecoverManagedSurface({
            error,
            attempt: managedLoadAttempt,
            opened: managed.opened,
            reset: managed.reset,
            policy: recoveryPolicy,
          })) throw error;
          managedLifecycleEvents.push(captureSurfaceEvent("release_requested", source, {
            outcome: adapterRecovery
              ? "managed_adapter_readiness_retry"
              : "managed_navigation_retry",
            causeCode: error.code,
            recoveryReason: adapterRecovery?.reason ?? null,
            recoveryAttempt: managedLoadAttempt + 1,
          }));
          const releaseOutcome = await managedCaptureWindow.releaseSource(
            source,
            captureLeaseId,
          );
          managedLifecycleEvents.push(...(releaseOutcome?.events ?? []));
          if (!managedSurfaceReleaseAllowsRecreate(releaseOutcome)) {
            throw new AkuBridgeError(
              "managed_surface_release_incomplete",
              "cleanup",
              "AkuBridge could not safely recycle the stalled managed source surface.",
              {
                source,
                releaseReason: String(
                  releaseOutcome?.reason ?? releaseOutcome?.mode ?? "unknown",
                ).slice(0, 80),
              },
            );
          }
          managedLifecycleEvents.push(captureSurfaceEvent("reconciled", source, {
            outcome: adapterRecovery
              ? "managed_adapter_readiness_recreated"
              : "managed_navigation_recreated",
            causeCode: error.code,
            recoveryReason: adapterRecovery?.reason ?? null,
            recoveryAttempt: managedLoadAttempt + 1,
          }));
          managedLoadAttempt += 1;
          managed = null;
        }
      }
      let captureTab = managed.tab;
      let captureTabOpened = managed.opened;
      let captureVisibilityMode = "managed_window";
      if (targetUrl) {
        captureTab = await managed.openTargetTab(
          assertRecaptureTarget(source, targetUrl),
        );
        targetCaptureTabId = captureTab.id;
        captureTabOpened = true;
        if (visibilityPlan.foregroundAuthorized) {
          await managed.showForeground();
          captureVisibilityMode = "managed_window_foreground";
        }
        await waitForTabComplete(captureTab.id, 20_000);
        if (!visibilityPlan.foregroundAuthorized) {
          await managed.requireFocus("target_loaded");
        }
        captureTab = await chrome.tabs.get(captureTab.id);
      }
      const prepared = await prepareSourceTab(captureTab, source, captureTabOpened, {
        ownership: "managed",
        captureVisibilityPolicy: visibilityPlan.policy,
        captureVisibilityMode,
        workingTabPreserved: true,
        openedTabDisposition: targetUrl ? "close_after_capture" : "close_after_session",
        requireVisualHydration,
        restoreFocus: managed.verifyFocus,
        hydrationTimeoutMs: requestedHydrationTimeoutMs,
        lifecycleEvents: managed.lifecycleEvents,
      });
      prepared.closeOnExit = Boolean(targetUrl);
      return prepared;
    } catch (error) {
      const lifecycleEvents = managed?.lifecycleEvents?.length
        ? [...managed.lifecycleEvents]
        : [...managedLifecycleEvents];
      if (Number.isInteger(targetCaptureTabId)) {
        await chrome.tabs.remove(targetCaptureTabId).catch(() => undefined);
        targetCaptureTabId = null;
      }
      if (managed) await managed.verifyFocus().catch(() => undefined);
      if (!targetUrl) {
        lifecycleEvents.push(captureSurfaceEvent("release_requested", source, {
          outcome: "surface_prepare_failed",
          causeCode: error?.code ?? "bridge_failure",
        }));
        const releaseOutcome = await managedCaptureWindow.releaseSource(
          source,
          captureLeaseId,
        ).catch(() => null);
        lifecycleEvents.push(...(releaseOutcome?.events ?? []));
      }
      error.captureSurfaceLifecycle = lifecycleEvents;
      if (["visible_recovery_required", "source_unavailable", "login_required"].includes(error?.code)) {
        throw error;
      }
      const wrapped = new AkuBridgeError(
        "visible_recovery_required",
        "capture_visibility",
        `Quiet capture could not prepare the managed ${source} surface: ${String(error?.message ?? error)}`,
        {
          source,
          causeCode: error?.code ?? "bridge_failure",
          causeDetails: error?.details ?? null,
        },
      );
      wrapped.captureSurfaceLifecycle = lifecycleEvents;
      throw wrapped;
    }
  }

  const patterns = matchPatternsFor(source);
  const captureWindowIds = await managedCaptureWindow.windowIds();
  const readerWindowId = await readerWindow.currentWindowId({
    excludedWindowIds: captureWindowIds,
  });
  const tabs = (await chrome.tabs.query({ url: patterns }))
    .filter((candidate) => candidate.windowId !== readerWindowId);
  const selected = chooseSourceTab(tabs, { source, mode });
  let tab = selected;
  let opened = false;
  const lifecycleEvents = [];
  if (!openIfMissing) {
    if (!tab) {
      const expectation = mode === "catch_up" ? ` feed tab (${expectedFeedUrl(source)})` : " tab";
      throw new Error(`No open, rendered ${source}${expectation} was found.`);
    }
  } else if (!tab) {
    const managed = await managedCaptureWindow.prepare(source, {
      openIfMissing: true,
      leaseId: captureLeaseId,
      windowIsolation: "shared",
    });
    lifecycleEvents.push(...(managed.lifecycleEvents ?? []));
    tab = managed.tab;
    opened = managed.opened;
    if (managed.opened || managed.reset) {
      await waitForTabComplete(tab.id, 20_000, {
        source,
        phase: managed.reset ? "adaptive_feed_reset" : "adaptive_capture_window_created",
      });
      tab = await chrome.tabs.get(tab.id);
    }
    const prepared = await prepareSourceTab(tab, source, opened, {
      ownership: "managed",
      captureVisibilityPolicy: visibilityPlan.policy,
      captureVisibilityMode: "managed_window_adaptive",
      workingTabPreserved: true,
      openedTabDisposition: "close_after_session",
      hydrationTimeoutMs: requestedHydrationTimeoutMs,
      requireVisualHydration,
      restoreFocus: managed.verifyFocus,
      lifecycleEvents,
    });
    prepared.closeOnExit = false;
    return prepared;
  }
  const bridgeOwned = opened || await managedCaptureWindow.isTrackedTab(
    source,
    tab.id,
    captureLeaseId,
  );
  if (!opened && bridgeOwned) {
    lifecycleEvents.push(captureSurfaceEvent("reused", source, {
      isolation: "shared_adaptive",
    }));
  }
  return prepareSourceTab(tab, source, opened, {
    ownership: bridgeOwned ? "managed" : "shared",
    captureVisibilityPolicy: visibilityPlan.policy,
    captureVisibilityMode: "same_window",
    openedTabDisposition: bridgeOwned ? "close_after_session" : "preserve",
    hydrationTimeoutMs: requestedHydrationTimeoutMs,
    requireVisualHydration,
    lifecycleEvents,
  });
}

async function findReadyReusableSourceTab(source) {
  if (sourceDefinition(source)?.captureReuse?.readyInactiveCanonicalTab !== true) {
    return null;
  }
  const tabs = await chrome.tabs.query({ url: matchPatternsFor(source) });
  const candidates = tabs
    .filter((tab) => tab.active !== true && isCanonicalFeedUrl(tab.url, source))
    .sort((left, right) => Number(right.lastAccessed ?? 0) - Number(left.lastAccessed ?? 0))
    .slice(0, 3);
  const expected = bridgeCapabilities();
  for (const tab of candidates) {
    const readiness = await probeSourceReadiness(tab.id, source).catch(() => null);
    if (
      readiness?.runtimeRevision === expected.runtimeRevision &&
      readiness?.adapterVersion === expected.adapterVersions[source] &&
      readiness.state === "feed_ready" &&
      readiness.feedRootPresent === true &&
      readiness.visualHydrationReady === true &&
      Number(readiness.visibleSelectorCandidateCount ?? 0) > 0
    ) {
      return { tab, readiness };
    }
  }
  return null;
}

async function deliverStructuredMediaEvidence(tabId, requestId, evidence) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "AKU_BROWSER_STRUCTURED_MEDIA_READY",
        requestId,
        evidence,
      });
      if (response?.ok) return true;
    } catch {
      // A stale content-script generation may be reinjected by the parallel capture path.
    }
    if (attempt === 0) await delay(50);
  }
  return false;
}

async function collectFacebookStructuredMediaEvidence(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resolveFacebookStructuredMediaInMainWorld,
      args: [{
        maxCandidates: 16,
        maxScripts: 32,
        maxScriptBytes: 256_000,
        maxTotalBytes: 2_000_000,
        maxTraversalNodes: 20_000,
        maxDepth: 40,
      }],
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    return {
      runtimeRevision: "facebook-main-world-media-resolver-v1",
      resolverVersion: "facebook-structured-video-v1",
      candidates: [],
      diagnostics: {
        status: "unavailable",
        reason: String(error?.message ?? error).slice(0, 300),
      },
    };
  }
}

async function collectInstagramStructuredMediaEvidence(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resolveInstagramStructuredMediaInMainWorld,
      args: [{
        maxCandidates: 16,
        maxMediaPerCandidate: 20,
        maxScripts: 48,
        maxDocumentScripts: 96,
        maxScriptBytes: 512_000,
        maxTotalBytes: 2_000_000,
        maxTraversalNodes: 20_000,
        maxDepth: 40,
      }],
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    return {
      runtimeRevision: "instagram-main-world-media-resolver-v2",
      resolverVersion: "instagram-structured-carousel-v2",
      candidates: [],
      diagnostics: {
        status: "unavailable",
        reason: String(error?.message ?? error).slice(0, 300),
      },
    };
  }
}

async function collectLinkedInStructuredMediaEvidence(tabId, request = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resolveLinkedInStructuredMediaInMainWorld,
      args: [{
        candidateIds: (Array.isArray(request.candidateIds) ? request.candidateIds : [])
          .filter((value) => /^linkedin:(?:activity|ugcpost|share):\d{5,30}$/i.test(String(value ?? "")))
          .slice(0, 4),
        playerIds: (Array.isArray(request.playerIds) ? request.playerIds : [])
          .map((value) => String(value ?? "").trim().slice(0, 240))
          .filter(Boolean)
          .slice(0, 4),
        maxCandidates: 16,
        maxPlayers: 16,
        maxTraversalNodes: 3_000,
        maxDepth: 10,
      }],
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    return {
      runtimeRevision: "linkedin-main-world-media-resolver-v1",
      resolverVersion: "linkedin-main-world-video-v1",
      candidates: [],
      diagnostics: {
        status: "unavailable",
        reason: String(error?.message ?? error).slice(0, 300),
      },
    };
  }
}

function assertRecaptureTarget(source, rawUrl) {
  const url = new URL(rawUrl);
  if (!isNativePostUrl(url.href, source)) throw new Error("Media recapture target is not a supported native post URL.");
  url.hash = "";
  return url.href;
}

async function prepareSourceTab(tab, source, opened, options = {}) {
  const lease = createTabLease(tab, source, opened);
  const startedAt = Date.now();
  const backgroundAtDispatch = tab.active !== true;
  let activatedForReadiness = false;
  const requireVisualHydration = options.requireVisualHydration ?? sourceRequiresVisualHydration(source);
  let previousActiveTabId = null;
  const activate = async () => {
    if (previousActiveTabId === null) {
      previousActiveTabId = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id ?? null;
    }
    const currentlyActive = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
    if (currentlyActive !== tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      activatedForReadiness = true;
      return true;
    }
    return false;
  };
  let readiness = options.prevalidatedReadiness ?? null;
  const readinessPolicy = sourceDefinition(source)?.readiness ?? {};
  const hydrationTimeoutMs = sourceHydrationTimeout(source, options.hydrationTimeoutMs);
  const initialTimeoutMs = Math.min(
    readinessPolicy.initialTimeoutMs ?? hydrationTimeoutMs,
    hydrationTimeoutMs,
  );
  const retryAfterActivationMs = readinessPolicy.retryAfterActivationMs
    ? Math.max(1_000, hydrationTimeoutMs - initialTimeoutMs)
    : 0;
  if (readiness && isSourceCaptureReady(readiness) && (
    !requireVisualHydration || readiness.visualHydrationReady === true
  )) {
    // A source-owned, inactive canonical tab may already be fully rendered.
    // Reuse that evidence without stealing focus merely to repeat readiness.
  } else if (readinessPolicy.activateWhenBackground === true && backgroundAtDispatch) {
    // Some sources defer visual hydration while the feed remains in a
    // background tab. The source catalog owns that capability declaration.
    await activate();
    readiness = await waitForSourceReady(
      tab.id,
      source,
      initialTimeoutMs,
      { requireVisualHydration },
    );
  } else {
    readiness = await waitForSourceReady(
      tab.id,
      source,
      initialTimeoutMs,
      { requireVisualHydration },
    );
  }
  if (retryAfterActivationMs && readiness.state !== "feed_ready") {
    await activate();
    readiness = await waitForSourceReady(tab.id, source, retryAfterActivationMs);
  }
  readiness.waitMs = Date.now() - startedAt;
  const captureReady = isSourceCaptureReady(readiness);
  const structuredFeedResult = !captureReady
    ? await collectStructuredFeedFallback(tab.id, source, readiness)
    : null;
  const structuredFeedFallback = structuredFeedResult?.observation ?? null;
  if (!captureReady && !structuredFeedFallback) {
    await restoreTabFocus(previousActiveTabId, tab.id);
    if (readiness.state === "source_unavailable") {
      throw new AkuBridgeError(
        "source_unavailable",
        "readiness",
        readiness.availability?.message ?? `${sourceLabel(source)} is temporarily unavailable.`,
        { source, availability: readiness.availability ?? null },
      );
    }
    if (readiness.state === "login_required") {
      throw new AkuBridgeError(
        "login_required",
        "readiness",
        `${sourceLabel(source)} requires a signed-in source session.`,
        { source },
      );
    }
    throw new AkuBridgeError(
      "source_readiness_failed",
      "readiness",
      `${sourceLabel(source)} source readiness failed: ${readiness.state} ` +
      `(${readiness.selectorCandidateCount} selector candidates, ` +
      `${readiness.visibleSelectorCandidateCount ?? 0} visible, ` +
      `${readiness.windowVisibleSelectorCandidateCount ?? 0} window-visible, ` +
      `structural=${readiness.structuralCandidateCount ?? 0}, ` +
      `structural-visible=${readiness.visibleStructuralCandidateCount ?? 0}, ` +
      `semantic=${readiness.semanticSelectorCandidateCount ?? 0}, ` +
      `action=${readiness.actionAnchoredCandidateCount ?? 0}, ` +
      `visual=${readiness.visualHydrationReady ?? "not_required"}, ` +
      `avatar=${readiness.hydratedPrimaryAvatarCount ?? 0}/${readiness.primaryAvatarContainerCount ?? 0}, ` +
      `media=${readiness.hydratedMediaContainerCount ?? 0}/${readiness.mediaContainerCount ?? 0}, ` +
      `loading=${readiness.loadingIndicator}, feedRoot=${readiness.feedRootPresent}, ` +
      `scroll=${readiness.scrollContext ?? "unknown"}, ` +
      `document=${readiness.documentReadyState ?? "unknown"}).`,
      {
        source,
        readiness,
        structuredFeedFallback: structuredFeedResult?.diagnostics ?? null,
      },
    );
  }
  return {
    tab,
    lease,
    opened,
    backgroundAtDispatch,
    freshnessBackgroundAtDispatch: options.passiveReadyReuse === true
      ? false
      : backgroundAtDispatch,
    readiness,
    structuredFeedFallback,
    structuredFeedDiagnostics: structuredFeedResult?.diagnostics ?? null,
    activatedForReadiness,
    activateForRetry: activate,
    ownership: options.ownership ?? (opened ? "managed" : "shared"),
    openedTabDisposition: options.openedTabDisposition ?? (opened ? "close_after_session" : "preserve"),
    captureVisibilityPolicy: options.captureVisibilityPolicy ?? "quiet",
    captureVisibilityMode: options.captureVisibilityMode ?? "same_window",
    workingTabPreserved: options.workingTabPreserved === true,
    restoreFocus: options.restoreFocus ?? (() => restoreTabFocus(previousActiveTabId, tab.id)),
    lifecycleEvents: Array.isArray(options.lifecycleEvents) ? options.lifecycleEvents : [],
  };
}

async function collectStructuredFeedFallback(tabId, source, readiness) {
  if (!shouldUseInstagramStructuredFeedFallback({
    source,
    configuredFallback: sourceDefinition(source)?.captureFallback?.emptyShell,
    readiness,
  })) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: resolveInstagramStructuredFeedInMainWorld,
      args: [{
        maxCandidates: 5,
        maxMediaPerCandidate: 20,
        maxScripts: 48,
        maxDocumentScripts: 96,
        maxScriptBytes: 512_000,
        maxTotalBytes: 2_000_000,
        maxTraversalNodes: 20_000,
        maxDepth: 40,
        maxCaptionCharacters: 4_000,
      }],
    });
    const evidence = results?.[0]?.result ?? null;
    const diagnostics = evidence?.diagnostics && typeof evidence.diagnostics === "object"
      ? { ...evidence.diagnostics, attempted: true }
      : { attempted: true, outcome: "no_diagnostics" };
    if (!Array.isArray(evidence?.candidates) || evidence.candidates.length === 0) {
      return {
        observation: null,
        diagnostics: { ...diagnostics, outcome: "no_candidates" },
      };
    }
    return {
      observation: instagramStructuredFeedObservation(evidence),
      diagnostics: { ...diagnostics, outcome: "candidates_found" },
    };
  } catch {
    return {
      observation: null,
      diagnostics: { attempted: true, outcome: "execution_failed" },
    };
  }
}

function isSourceCaptureReady(readiness) {
  return readiness.state === "feed_ready" || readiness.state === "feed_empty";
}

async function assertTabLease(lease, stage) {
  let tab;
  try {
    tab = await chrome.tabs.get(lease.tabId);
  } catch (error) {
    throw new AkuBridgeError(
      "tab_stale",
      stage,
      `AkuBridge source tab lease expired: ${String(error?.message ?? error)}`,
      { tabId: lease.tabId, source: lease.source },
    );
  }
  const validation = validateTabLease(lease, tab);
  if (!validation.valid) {
    throw new AkuBridgeError(
      validation.code,
      stage,
      `AkuBridge source tab lease failed: ${validation.reason}.`,
      { tabId: lease.tabId, source: lease.source, boundUrl: lease.boundUrl, currentUrl: tab.url },
    );
  }
}

async function waitForSourceReady(
  tabId,
  source,
  timeoutMs,
  { requireVisualHydration = false } = {},
) {
  const startedAt = Date.now();
  let inPageRecoveryAttempted = false;
  let latest = {
    state: "page_shell",
    selectorCandidateCount: 0,
    visibleSelectorCandidateCount: 0,
    structuralCandidateCount: 0,
    visibleStructuralCandidateCount: 0,
    loadingIndicator: false,
    feedRootPresent: false,
    scrollContext: "unknown",
    windowVisibleSelectorCandidateCount: 0,
  };
  while (Date.now() - startedAt < timeoutMs) {
    latest = await probeSourceReadiness(tabId, source);
    if (latest.state === "feed_ready" && (
      !requireVisualHydration || latest.visualHydrationReady === true
    )) break;
    if (latest.diagnosis === "dom_contract_mismatch" && latest.visualHydrationReady === true) break;
    if (["login_required", "source_unavailable", "wrong_page"].includes(latest.state)) break;
    if (!inPageRecoveryAttempted && latest.recoveryHint?.inPageAction) {
      inPageRecoveryAttempted = true;
      await recoverSourceReadiness(tabId, source, latest).catch(() => null);
    }
    await delay(250);
  }
  return { ...latest, waitMs: Date.now() - startedAt };
}

async function recoverSourceReadiness(tabId, source, readiness) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "AKU_BROWSER_RECOVER_SOURCE_READINESS",
    source,
    readiness: {
      state: readiness?.state ?? "page_shell",
      recoveryHint: readiness?.recoveryHint ?? null,
    },
  });
  return response?.ok ? response.recovery ?? null : null;
}

async function probeSourceReadiness(tabId, source) {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_PROBE_SOURCE_READY",
      source,
    });
  } catch {
    response = null;
  }
  const expected = bridgeCapabilities();
  const current = response?.readiness;
  if (
    response?.ok &&
    current &&
    current.runtimeRevision === expected.runtimeRevision &&
    current.adapterVersion === expected.adapterVersions[source]
  ) return current;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: SOURCE_SCRIPT_FILES,
  });
  response = await chrome.tabs.sendMessage(tabId, {
    type: "AKU_BROWSER_PROBE_SOURCE_READY",
    source,
  });
  return response?.readiness ?? {
    state: "page_shell",
    selectorCandidateCount: 0,
    visibleSelectorCandidateCount: 0,
    structuralCandidateCount: 0,
    visibleStructuralCandidateCount: 0,
  };
}

async function probeSourceSessions() {
  const observedAt = new Date().toISOString();
  const sessions = {};
  for (const source of sourceIds()) {
    const tabs = await chrome.tabs.query({ url: matchPatternsFor(source) }).catch(() => []);
    const candidates = tabs
      .filter((tab) => Number.isInteger(tab?.id))
      .sort((left, right) => Number(right.active) - Number(left.active) ||
        Number(right.lastAccessed ?? 0) - Number(left.lastAccessed ?? 0))
      .slice(0, SOURCE_SESSION_MAX_TABS);
    const observations = [];
    for (const tab of candidates) {
      const readiness = await probeSourceReadiness(tab.id, source).catch(() => null);
      observations.push({
        tab,
        readiness: tab.status && tab.status !== "complete"
          ? { state: "loading" }
          : readiness,
      });
    }
    const state = observations.length === 0
      ? "not_observed"
      : sourceSessionStateForTabs(observations);
    sessions[source] = createSourceSessionObservation({
      source,
      state,
      observedAt,
      tabCount: observations.length,
      detail: state === "not_observed"
        ? "No existing source tab was observed."
        : state === "unknown"
          ? "Existing source tab did not expose a conclusive readiness state."
          : null,
    });
  }
  return sessions;
}

async function openSourceFeed(source) {
  if (!sourceIds().includes(source)) {
    throw new Error("Source is not in the AkuBrowser allowlist.");
  }
  const definition = sourceDefinition(source);
  if (!definition?.feedUrl) throw new Error("Source has no canonical feed URL.");
  if (!await sourceAccessGranted(chrome, source)) {
    const permissionUrl = chrome.runtime.getURL(
      `source-permission.html?source=${encodeURIComponent(source)}`,
    );
    const tab = await chrome.tabs.create({ url: permissionUrl, active: true });
    return {
      source,
      state: "permission_required",
      url: tab?.url ?? permissionUrl,
    };
  }
  const tab = await chrome.tabs.create({ url: definition.feedUrl, active: true });
  return { source, state: "source_opened", url: tab?.url ?? definition.feedUrl };
}

async function openNativePostInReaderWindow(source, value) {
  if (!sourceIds().includes(source)) {
    throw new Error("Native reader source is not in the AkuBrowser allowlist.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Native reader URL is invalid.");
  }
  if (sourceForUrl(url.href) !== source || !isNativePostUrl(url.href, source)) {
    throw new Error("Native reader URL is not an allowlisted post for this source.");
  }
  const result = await readerWindow.open(url.href, {
    excludedWindowIds: await managedCaptureWindow.windowIds(),
  });
  return { source, state: "native_post_opened", url: result.url };
}

async function probeSourceFreshness(tabId, source) {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_PROBE_SOURCE_FRESHNESS",
      source,
    });
  } catch {
    response = null;
  }
  if (response?.ok && response.freshness?.runtimeRevision === "source-freshness-runtime-v1") {
    return response.freshness;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: SOURCE_SCRIPT_FILES,
  });
  response = await chrome.tabs.sendMessage(tabId, {
    type: "AKU_BROWSER_PROBE_SOURCE_FRESHNESS",
    source,
  });
  if (!response?.ok) throw new Error(response?.message || "Source freshness probe failed.");
  return response.freshness;
}

async function revealPendingSourceContent(tabId, payload) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "AKU_BROWSER_REVEAL_PENDING_CONTENT",
    source: payload.source,
    options: {
      timeoutMs: payload.pendingContentTimeoutMs,
      settleMs: payload.pendingContentSettleMs,
    },
  });
  if (!response?.ok) throw new Error(response?.message || "Pending-content reveal failed.");
  return response.freshness;
}

async function restoreTabFocus(previousActiveTabId, sourceTabId) {
  if (!previousActiveTabId || previousActiveTabId === sourceTabId) {
    return { changed: false, restored: false, preserved: true };
  }
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    const currentlyActive = (await chrome.tabs.query({
      active: true,
      windowId: sourceTab.windowId,
    }))[0]?.id;
    if (currentlyActive !== sourceTabId) {
      return { changed: true, restored: true, preserved: false };
    }
    await chrome.tabs.update(previousActiveTabId, { active: true });
    return { changed: true, restored: true, preserved: false };
  } catch {
    // The user may have closed or moved the previous tab during the bounded capture.
    return { changed: true, restored: false, preserved: false };
  }
}

function sourceLabel(source) {
  return sourceDefinition(source)?.displayName ?? source;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectFromTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_COLLECT_VISIBLE",
      payload,
    });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: SOURCE_SCRIPT_FILES,
    });
    return chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_COLLECT_VISIBLE",
      payload,
    });
  }
}

async function collectFromTabWithDeadline(tabId, payload) {
  const timeoutMs = Math.max(
    5_000,
    Math.min(60_000, Number(payload.captureTimeoutMs ?? 45_000) + 5_000),
  );
  let timeoutId;
  try {
    return await Promise.race([
      collectFromTab(tabId, payload),
      new Promise((_, reject) => {
        timeoutId = setTimeout(async () => {
          const diagnostics = await chrome.tabs.sendMessage(tabId, {
            type: "AKU_BROWSER_CAPTURE_DIAGNOSTICS",
          }).catch(() => null);
          const detail = diagnostics?.diagnostics
            ? ` Last content stage: ${JSON.stringify(diagnostics.diagnostics)}.`
            : "";
          reject(new Error(
            `AkuBridge content capture exceeded its bounded response deadline.${detail}`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForTabComplete(tabId, timeoutMs, options = {}) {
  const startedAt = Date.now();
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return tabNavigationReady("tab_complete", startedAt, existing);
  const sourcePolicy = sourceDefinition(options.source);
  const navigationMode = sourcePolicy?.navigation?.readinessMode;
  if (navigationMode) {
    return waitForTabCompleteOrSourceReady(tabId, timeoutMs, {
      ...options,
      startedAt,
      navigationMode,
      expectedAdapterVersion: sourcePolicy.adapterVersion,
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      callback();
    };
    const timeout = setTimeout(() => {
      void chrome.tabs.get(tabId)
        .catch(() => null)
        .then((latest) => finish(() => reject(tabLoadTimeoutError(latest, startedAt, options))));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo, updatedTab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish(() => resolve(tabNavigationReady("tab_complete", startedAt, updatedTab)));
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Close the get-before-listener race without changing established source behavior.
    void chrome.tabs.get(tabId).then((latest) => {
      if (latest.status === "complete") {
        finish(() => resolve(tabNavigationReady("tab_complete", startedAt, latest)));
      }
    }).catch((error) => finish(() => reject(error)));
  });
}

async function waitForTabCompleteOrSourceReady(
  tabId,
  timeoutMs,
  {
    source,
    phase,
    startedAt,
    navigationMode,
    expectedAdapterVersion,
  },
) {
  const expectedRuntimeRevision = bridgeCapabilities().runtimeRevision;
  let latest = await chrome.tabs.get(tabId);
  while (Date.now() - startedAt < timeoutMs) {
    if (latest.status === "complete") {
      return tabNavigationReady("tab_complete", startedAt, latest);
    }
    const readiness = await probeRegisteredSourceReadiness(tabId, source);
    latest = await chrome.tabs.get(tabId);
    const outcome = navigationReadinessOutcome({
      mode: navigationMode,
      tabStatus: latest.status,
      readiness,
      expectedSource: source,
      expectedAdapterVersion,
      expectedRuntimeRevision,
      canonicalFeed: isCanonicalFeedUrl(latest.url, source),
    });
    if (outcome.ready) return tabNavigationReady(outcome.reason, startedAt, latest);
    await delay(Math.min(250, Math.max(0, timeoutMs - (Date.now() - startedAt))));
  }
  throw tabLoadTimeoutError(latest, startedAt, { source, phase });
}

async function probeRegisteredSourceReadiness(tabId, source) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_PROBE_SOURCE_READY",
      source,
    });
    return response?.ok ? response.readiness ?? null : null;
  } catch {
    return null;
  }
}

function tabNavigationReady(reason, startedAt, tab) {
  return {
    reason,
    elapsedMs: Date.now() - startedAt,
    tabStatus: tab?.status ?? "closed",
  };
}

function tabLoadTimeoutError(latest, startedAt, options = {}) {
  return new AkuBridgeError(
    "tab_load_timeout",
    "navigation",
    "Source tab did not finish loading in time.",
    {
      source: sourceIds().includes(options.source) ? options.source : null,
      phase: String(options.phase ?? "source_navigation").slice(0, 80),
      elapsedMs: Date.now() - startedAt,
      status: latest?.status ?? "closed",
      canonicalFeed: latest ? isCanonicalFeedUrl(latest.url, options.source) : false,
      observedSource: latest ? sourceForUrl(latest.url) : null,
    },
  );
}

function assertEndpoint(endpoint) {
  if (!isAkuBrowserOrigin(endpoint)) {
    throw new Error("Dispatch rejected: unsupported sidecar endpoint.");
  }
}

async function responseError(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  return payload.message || `${fallback} (${response.status})`;
}

function bridgeCapabilities() {
  return createBridgeCapabilities(chrome.runtime.getManifest());
}

async function bridgeCapabilitiesWithSourceAccess() {
  const permissions = await chrome.permissions.getAll();
  const sources = await sourceAccessReadiness(chrome);
  return {
    ...bridgeCapabilities(),
    sourceAccess: {
      grantedSources: sourcesForGrantedOrigins(permissions.origins),
      sources,
      observedAt: new Date().toISOString(),
    },
  };
}
