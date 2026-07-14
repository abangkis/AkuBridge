import { chooseSourceTab, expectedFeedUrl } from "./source-tab-policy.js";
import { shouldRetrySourceTab } from "./tab-recovery-policy.js";
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
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_ID,
  createBridgeCapabilities,
} from "./bridge-capabilities.js";

const AKU_BROWSER_ORIGIN = "http://127.0.0.1:47821";
const CAPTURE_DELAY_MAX_MS = 2_000;
const PENDING_SELF_RELOAD_KEY = "akuBridgePendingSelfReload";
const PENDING_SELF_RELOAD_MAX_AGE_MS = 30_000;
const commandGuard = createCommandGuard();
const SOURCE_SCRIPT_FILES = [
  "bounded-capture-policy.js",
  "capture-quality-policy.js",
  "linkedin-permalink-policy.js",
  "linkedin-timestamp-policy.js",
  "source-adapter-runtime.js",
  "adapters/x-adapter.js",
  "adapters/linkedin-adapter.js",
  "source-freshness-runtime.js",
  "media-recovery-runtime.js",
  "content-script.js",
];

void resumePendingSelfReload().catch((error) => {
  console.error("AkuBridge could not resume the pending AkuBrowser tab reload.", error);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${AKU_BROWSER_ORIGIN}/`, active: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AKU_BRIDGE_GET_CAPABILITIES") {
    sendResponse({ ok: true, capabilities: bridgeCapabilities() });
    return false;
  }
  if (message?.type === "AKU_BRIDGE_RELOAD_SELF") {
    if (!sender.url?.startsWith(`${AKU_BROWSER_ORIGIN}/`)) {
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
  if (!sender.url?.startsWith(`${AKU_BROWSER_ORIGIN}/`)) {
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
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && (
      url.hostname === "x.com" ||
      url.hostname === "www.linkedin.com"
    );
  } catch {
    return false;
  }
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

async function captureWithSourceTabRecovery(command) {
  for (let attempt = 0; ; attempt += 1) {
    let prepared = null;
    try {
      prepared = await findOrOpenSourceTab(
        command.payload.source,
        command.payload.mode,
        command.payload.openIfMissing,
      );
      const observation = await capturePreparedSource(command, prepared, attempt);
      if (shouldCloseOpenedSourceTab({
        opened: prepared.opened,
        lifecycle: command.payload.tabLifecycle,
        captureCompleted: true,
      })) {
        await chrome.tabs.remove(prepared.tab.id).catch(() => undefined);
        observation.coverage.sourceTabClosedAfterCapture = true;
      }
      return observation;
    } catch (error) {
      if (!shouldRetrySourceTab({
        error,
        acquisitionRound: command.payload.acquisitionRound ?? 1,
        attempt,
      })) {
        throw error;
      }
    } finally {
      if (prepared) await prepared.restoreFocus();
    }
  }
}

async function capturePreparedSource(command, prepared, sourceTabRecoveryCount) {
  await assertTabLease(prepared.lease, "before_capture");
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
  const payload = {
    ...command.payload,
    sourceFreshness,
    sourceReadiness: prepared.readiness,
    tabAcquisition: {
      opened: prepared.opened,
      activatedForReadiness: prepared.activatedForReadiness,
      backgroundAtDispatch: prepared.backgroundAtDispatch,
      recoveryCount: sourceTabRecoveryCount,
      ownership: prepared.opened ? "managed" : "shared",
      openedTabDisposition:
        tabLifecycle.openedTabDisposition,
    },
  };
  const response = await collectFromTabWithDeadline(prepared.tab.id, payload);
  if (!response?.ok) throw new Error(response?.message || "Source content script failed.");
  await assertTabLease(prepared.lease, "after_capture");
  return response.observation;
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

function bridgeHeaders(token) {
  return {
    "X-Aku-Bridge-Token": token,
    "X-Aku-Bridge-Id": BRIDGE_ID,
    "X-Aku-Bridge-Contract": BRIDGE_CONTRACT_VERSION,
  };
}

async function findOrOpenSourceTab(source, mode, openIfMissing) {
  const patterns = source === "x" ? ["https://x.com/*"] : ["https://www.linkedin.com/*"];
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
  }
  return prepareSourceTab(tab, source, opened);
}

async function prepareSourceTab(tab, source, opened) {
  const lease = createTabLease(tab, source, opened);
  const startedAt = Date.now();
  const backgroundAtDispatch = tab.active !== true;
  let activatedForReadiness = false;
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
  if (source === "x" && backgroundAtDispatch) {
    // X defers image and video hydration while a feed tab remains in the
    // background. An initial post without media can otherwise make the
    // readiness probe look complete while later scrolled posts lose media.
    await activate();
    readiness = await waitForSourceReady(
      tab.id,
      source,
      12_000,
      { requireVisualHydration: true },
    );
  } else {
    readiness = await waitForSourceReady(
      tab.id,
      source,
      source === "linkedin" ? 3_000 : 12_000,
      { requireVisualHydration: source === "x" },
    );
  }
  if (source === "linkedin" && readiness.state !== "feed_ready") {
    await activate();
    readiness = await waitForSourceReady(tab.id, source, 15_000);
  }
  readiness.waitMs = Date.now() - startedAt;
  const captureReady = isSourceCaptureReady(readiness);
  if (!captureReady) {
    await restoreTabFocus(previousActiveTabId, tab.id);
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
    restoreFocus: () => restoreTabFocus(previousActiveTabId, tab.id),
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
    if (["login_required", "wrong_page"].includes(latest.state)) break;
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
  if (!previousActiveTabId || previousActiveTabId === sourceTabId) return;
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    const currentlyActive = (await chrome.tabs.query({
      active: true,
      windowId: sourceTab.windowId,
    }))[0]?.id;
    if (currentlyActive !== sourceTabId) return;
    await chrome.tabs.update(previousActiveTabId, { active: true });
  } catch {
    // The user may have closed or moved the previous tab during the bounded capture.
  }
}

function sourceLabel(source) {
  return source === "linkedin" ? "LinkedIn" : "X";
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
  if (endpoint !== AKU_BROWSER_ORIGIN) {
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
