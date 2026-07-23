import { chooseSourceTab, expectedFeedUrl } from "./source-tab-policy.js";
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
import { inspectCaptureSurface } from "./capture-surface-telemetry.js";
import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_ID,
  createBridgeCapabilities,
} from "./bridge-capabilities.js";
import { resolveXStructuredMediaInMainWorld } from "./x-main-world-media-resolver.js";
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

const AKU_BROWSER_ORIGIN = "http://127.0.0.1:11122";
const AKU_BROWSER_ORIGINS = new Set([
  AKU_BROWSER_ORIGIN,
  "http://localhost:11122",
]);
const CAPTURE_DELAY_MAX_MS = 2_000;
const PENDING_SELF_RELOAD_KEY = "akuBridgePendingSelfReload";
const PENDING_SELF_RELOAD_MAX_AGE_MS = 30_000;
const BACKGROUND_DISPATCH_CONFIG_KEY = "akuBridgeBackgroundDispatch";
const BACKGROUND_DISPATCH_ALARM = "akuBridgeBackgroundDispatch";
let backgroundDispatching = false;
const commandGuard = createCommandGuard();
const managedCaptureWindow = createManagedCaptureWindowRuntime(chrome);
const xMediaEvidenceStore = createXMediaEvidenceStore(chrome.storage.local);
const xAvatarEvidenceStore = createXAvatarEvidenceStore(chrome.storage.local);
const structuredMediaCollectors = new Map([
  ["x_response", collectXStructuredMediaEvidence],
]);
const SOURCE_SCRIPT_FILES = [
  "bounded-capture-policy.js",
  "capture-quality-policy.js",
  "source-adapter-runtime.js",
  ...sourceRuntimeScripts(),
  "source-freshness-runtime.js",
  "media-acquisition-engine.js",
  "content-script.js",
];

void resumePendingSelfReload().catch((error) => {
  console.error("AkuBridge could not resume the pending AkuBrowser tab reload.", error);
});
void restoreBackgroundDispatch().catch((error) => {
  console.error("AkuBridge could not restore background dispatch.", error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BACKGROUND_DISPATCH_ALARM) return;
  void pollBackgroundDispatch().catch((error) => console.warn("AkuBridge background dispatch deferred.", error));
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${AKU_BROWSER_ORIGIN}/`, active: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    sendResponse({ ok: true, capabilities: bridgeCapabilities() });
    return false;
  }
  if (message?.type === "AKU_BRIDGE_CONFIGURE_BACKGROUND_DISPATCH") {
    if (!isAkuBrowserOrigin(sender.url)) {
      sendResponse({ ok: false, message: "Background dispatch configuration rejected: invalid AkuBrowser origin." });
      return false;
    }
    configureBackgroundDispatch(message.endpoint, message.token)
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
    const release = typeof message.source === "string"
      ? managedCaptureWindow.releaseSource(message.source, message.leaseId)
      : managedCaptureWindow.release(message.leaseId);
    release
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
  if (message?.type !== "AKU_BROWSER_DISPATCH") return undefined;
  if (!isAkuBrowserOrigin(sender.url)) {
    sendResponse({ ok: false, message: "Dispatch rejected: invalid AkuBrowser origin." });
    return false;
  }
  dispatchRun(message)
    .then(() => sendResponse({ ok: true, capabilities: bridgeCapabilities() }))
    .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
  return true;
});

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
  await chrome.storage.local.remove(PENDING_SELF_RELOAD_KEY);
  if (
    !Number.isInteger(pending.tabId) ||
    !Number.isFinite(pending.requestedAt) ||
    Date.now() - pending.requestedAt > PENDING_SELF_RELOAD_MAX_AGE_MS
  ) return;
  // The new extension runtime owns this navigation, so the injected content
  // script remains valid and can publish the post-reload heartbeat.
  await chrome.tabs.reload(pending.tabId);
}

async function dispatchRun(message) {
  assertEndpoint(message.endpoint);
  const command = await claimCommand(message.endpoint, message.token, message.runId);
  if (!command) throw new Error("No queued browser command was available for this run.");
  if (!commandGuard.begin(command.id)) {
    throw new AkuBridgeError("duplicate_command", "dispatch", `AkuBridge rejected duplicate command ${command.id}.`);
  }

  if (message.background === true && typeof command.payload.captureLeaseId === "string") {
    await rememberBackgroundLease(message.endpoint, message.token, command.payload.captureLeaseId);
  }

  try {
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
    commandGuard.finish(command.id);
  } catch (error) {
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
      if (!sourceIds().includes(run?.source) || !["completed", "failed", "cancelled"].includes(run?.status) || releasedSources.has(run.source)) continue;
      const outcome = await managedCaptureWindow.releaseSource(run.source, config.activeLeaseId).catch(() => null);
      if (outcome && outcome.reason !== "lease_mismatch") releasedSources.add(run.source);
    }
  }
  if (!terminal) {
    const next = { ...config, releasedSources: [...releasedSources] };
    await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
    return next;
  }
  await managedCaptureWindow.release(config.activeLeaseId).catch(() => undefined);
  const next = { ...config };
  delete next.activeLeaseId;
  delete next.releasedSources;
  await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
  return next;
}

async function refreshBackgroundHeartbeat(config) {
  const response = await fetch(`${config.endpoint}/api/bridge/heartbeat`, {
    method: "POST",
    headers: { ...bridgeHeaders(config.token), "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: bridgeCapabilities() }),
  });
  if (response.status === 401 || response.status === 403) {
    await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
    await chrome.alarms.clear(BACKGROUND_DISPATCH_ALARM);
    return false;
  }
  if (!response.ok) throw new Error(await responseError(response, "Could not refresh background Bridge heartbeat"));
  return true;
}

async function configureBackgroundDispatch(endpoint, token) {
  assertEndpoint(endpoint);
  if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new Error("Background dispatch requires a valid Bridge token.");
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const current = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  const next = { endpoint, token };
  if (current?.endpoint === endpoint && current?.token === token && typeof current.activeLeaseId === "string") {
    next.activeLeaseId = current.activeLeaseId;
  }
  await chrome.storage.local.set({ [BACKGROUND_DISPATCH_CONFIG_KEY]: next });
  await chrome.alarms.create(BACKGROUND_DISPATCH_ALARM, { periodInMinutes: 1 });
  await pollBackgroundDispatch();
}

async function restoreBackgroundDispatch() {
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  const config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (!config) return;
  try {
    assertEndpoint(config.endpoint);
    if (typeof config.token !== "string" || config.token.length < 32) throw new Error("invalid stored token");
  } catch {
    await chrome.storage.local.remove(BACKGROUND_DISPATCH_CONFIG_KEY);
    return;
  }
  await chrome.alarms.create(BACKGROUND_DISPATCH_ALARM, { periodInMinutes: 1 });
  await pollBackgroundDispatch();
}

async function pollBackgroundDispatch() {
  if (backgroundDispatching) return;
  const stored = await chrome.storage.local.get(BACKGROUND_DISPATCH_CONFIG_KEY);
  let config = stored?.[BACKGROUND_DISPATCH_CONFIG_KEY];
  if (!config) return;
  backgroundDispatching = true;
  try {
    if (!(await refreshBackgroundHeartbeat(config))) return;
    config = await releaseTerminalBackgroundLease(config);
    if (!config) return;
    const response = await fetch(`${config.endpoint}/api/bridge/commands/pending`, { headers: bridgeHeaders(config.token), cache: "no-store" });
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
    } catch (error) {
      if (error?.message !== "No queued browser command was available for this run.") throw error;
    }
  } finally {
    backgroundDispatching = false;
  }
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
  const captureSurface = await inspectCaptureSurface(chrome, prepared.tab.id);
  const tabLifecycle = normalizeSourceTabLifecycle(command.payload.tabLifecycle);
  const sourceFreshness = await recoverSourceFreshness({
    source: command.payload.source,
    acquisitionRound: command.payload.acquisitionRound ?? 1,
    backgroundAtDispatch: prepared.backgroundAtDispatch,
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
  const structuredMediaEvidence = structuredCollector
    ? await structuredCollector(prepared.tab.id)
    : null;
  const payload = {
    ...command.payload,
    sourceFreshness,
    ...(sourcePolicy?.structuredMediaPayloadField
      ? { [sourcePolicy.structuredMediaPayloadField]: structuredMediaEvidence }
      : {}),
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
  const response = await collectFromTabWithDeadline(prepared.tab.id, payload);
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
) {
  const visibilityPlan = planCaptureVisibility({
    policy: requestedVisibilityPolicy,
    mode,
    foregroundAuthorized,
  });
  let targetCaptureTabId = null;
  if (visibilityPlan.initialMode === "managed_window") {
    let managed = null;
    try {
      managed = await managedCaptureWindow.prepare(source, {
        openIfMissing,
        leaseId: captureLeaseId,
        windowIsolation: visibilityPlan.windowIsolation,
      });
      if (managed.opened) await waitForTabComplete(managed.tab.id, 20_000);
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
        requireVisualHydration: !targetUrl || visibilityPlan.foregroundAuthorized,
        restoreFocus: managed.verifyFocus,
        hydrationTimeoutMs: requestedHydrationTimeoutMs,
      });
      prepared.closeOnExit = Boolean(targetUrl);
      return prepared;
    } catch (error) {
      if (Number.isInteger(targetCaptureTabId)) {
        await chrome.tabs.remove(targetCaptureTabId).catch(() => undefined);
        targetCaptureTabId = null;
      }
      if (managed) await managed.verifyFocus().catch(() => undefined);
      if (!targetUrl) {
        await managedCaptureWindow.releaseSource(source, captureLeaseId).catch(() => undefined);
      }
      if (["visible_recovery_required", "source_unavailable", "login_required"].includes(error?.code)) {
        throw error;
      }
      throw new AkuBridgeError(
        "visible_recovery_required",
        "capture_visibility",
        `Quiet capture could not prepare the managed ${source} surface: ${String(error?.message ?? error)}`,
        { source, causeCode: error?.code ?? "bridge_failure" },
      );
    }
  }

  const patterns = matchPatternsFor(source);
  const tabs = await chrome.tabs.query({ url: patterns });
  const selected = chooseSourceTab(tabs, { source, mode });
  let tab = selected;
  let opened = false;
  if (!openIfMissing) {
    if (!tab) {
      const expectation = mode === "catch_up" ? ` feed tab (${expectedFeedUrl(source)})` : " tab";
      throw new Error(`No open, rendered ${source}${expectation} was found.`);
    }
  } else if (!tab) {
    const url = expectedFeedUrl(source);
    tab = await chrome.tabs.create({ url, active: false });
    opened = true;
    await waitForTabComplete(tab.id, 20_000);
    tab = await chrome.tabs.get(tab.id);
    await managedCaptureWindow.trackOpenedTab(source, tab.id, captureLeaseId);
  }
  const bridgeOwned = opened || await managedCaptureWindow.isTrackedTab(
    source,
    tab.id,
    captureLeaseId,
  );
  return prepareSourceTab(tab, source, opened, {
    ownership: bridgeOwned ? "managed" : "shared",
    captureVisibilityPolicy: visibilityPlan.policy,
    captureVisibilityMode: "same_window",
    openedTabDisposition: bridgeOwned ? "close_after_session" : "preserve",
    hydrationTimeoutMs: requestedHydrationTimeoutMs,
  });
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
  let readiness;
  const readinessPolicy = sourceDefinition(source)?.readiness ?? {};
  const hydrationTimeoutMs = sourceHydrationTimeout(source, options.hydrationTimeoutMs);
  const initialTimeoutMs = readinessPolicy.retryAfterActivationMs
    ? Math.min(readinessPolicy.initialTimeoutMs ?? hydrationTimeoutMs, hydrationTimeoutMs)
    : hydrationTimeoutMs;
  const retryAfterActivationMs = readinessPolicy.retryAfterActivationMs
    ? Math.max(1_000, hydrationTimeoutMs - initialTimeoutMs)
    : 0;
  if (readinessPolicy.activateWhenBackground === true && backgroundAtDispatch) {
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
  if (!captureReady) {
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
    throw new Error(
      `${sourceLabel(source)} source readiness failed: ${readiness.state} ` +
      `(${readiness.selectorCandidateCount} selector candidates, ` +
      `${readiness.visibleSelectorCandidateCount ?? 0} visible, ` +
      `${readiness.windowVisibleSelectorCandidateCount ?? 0} window-visible, ` +
      `semantic=${readiness.semanticSelectorCandidateCount ?? 0}, ` +
      `action=${readiness.actionAnchoredCandidateCount ?? 0}, ` +
      `visual=${readiness.visualHydrationReady ?? "not_required"}, ` +
      `avatar=${readiness.hydratedPrimaryAvatarCount ?? 0}/${readiness.primaryAvatarContainerCount ?? 0}, ` +
      `media=${readiness.hydratedMediaContainerCount ?? 0}/${readiness.mediaContainerCount ?? 0}, ` +
      `loading=${readiness.loadingIndicator}, feedRoot=${readiness.feedRootPresent}, ` +
      `scroll=${readiness.scrollContext ?? "unknown"}, ` +
      `document=${readiness.documentReadyState ?? "unknown"}).`,
    );
  }
  return {
    tab,
    lease,
    opened,
    backgroundAtDispatch,
    readiness,
    activatedForReadiness,
    activateForRetry: activate,
    ownership: options.ownership ?? (opened ? "managed" : "shared"),
    openedTabDisposition: options.openedTabDisposition ?? (opened ? "close_after_session" : "preserve"),
    captureVisibilityPolicy: options.captureVisibilityPolicy ?? "quiet",
    captureVisibilityMode: options.captureVisibilityMode ?? "same_window",
    workingTabPreserved: options.workingTabPreserved === true,
    restoreFocus: options.restoreFocus ?? (() => restoreTabFocus(previousActiveTabId, tab.id)),
  };
}

function isSourceCaptureReady(readiness) {
  return readiness.state === "feed_ready";
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
  let latest = {
    state: "page_shell",
    selectorCandidateCount: 0,
    visibleSelectorCandidateCount: 0,
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
    if (["login_required", "source_unavailable", "wrong_page"].includes(latest.state)) break;
    await delay(250);
  }
  return { ...latest, waitMs: Date.now() - startedAt };
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
  };
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

async function waitForTabComplete(tabId, timeoutMs) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Source tab did not finish loading in time."));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
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
