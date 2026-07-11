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

const AKU_BROWSER_ORIGIN = "http://127.0.0.1:47821";
const BRIDGE_ID = "aku-bridge-chrome-mv3-v0";
const BRIDGE_CONTRACT_VERSION = "aku-browser.bridge.v1";
const commandGuard = createCommandGuard();
const SOURCE_SCRIPT_FILES = [
  "bounded-capture-policy.js",
  "source-adapter-runtime.js",
  "adapters/x-adapter.js",
  "adapters/linkedin-adapter.js",
  "content-script.js",
];

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${AKU_BROWSER_ORIGIN}/`, active: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AKU_BRIDGE_GET_CAPABILITIES") {
    sendResponse({ ok: true, capabilities: bridgeCapabilities() });
    return false;
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
  const payload = {
    ...command.payload,
    ...(command.payload.source === "linkedin" && prepared.backgroundAtDispatch
      ? { pendingContentPolicy: "detect_only", sameTabMutationAllowed: false }
      : {}),
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
  let response = await collectFromTabWithDeadline(prepared.tab.id, payload);
  if (!response?.ok) throw new Error(response?.message || "Source content script failed.");
  if (command.payload.source === "linkedin" && observationBlockCount(response.observation) === 0) {
    const activatedForRetry = await prepared.activateForRetry();
    const readiness = await waitForSourceReady(prepared.tab.id, "linkedin", 8_000);
    response = await collectFromTabWithDeadline(prepared.tab.id, {
      ...payload,
      pendingContentPolicy: "detect_only",
      sameTabMutationAllowed: false,
      sourceReadiness: readiness,
      sourceReadinessRetryCount: 1,
      tabAcquisition: {
        opened: prepared.opened,
        activatedForReadiness:
          prepared.activatedForReadiness || activatedForRetry,
        backgroundAtDispatch: prepared.backgroundAtDispatch,
        recoveryCount: sourceTabRecoveryCount,
        ownership: prepared.opened ? "managed" : "shared",
        openedTabDisposition:
          tabLifecycle.openedTabDisposition,
      },
    });
    if (!response?.ok) throw new Error(response?.message || "Source readiness retry failed.");
  }
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
  let readiness = await waitForSourceReady(tab.id, source, source === "linkedin" ? 3_000 : 8_000);
  let activatedForReadiness = false;
  let previousActiveTabId = null;
  const activate = async () => {
    if (previousActiveTabId === null) {
      previousActiveTabId = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id ?? null;
    }
    if (previousActiveTabId !== tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      activatedForReadiness = true;
      return true;
    }
    return false;
  };
  if (source === "linkedin" && readiness.state !== "feed_ready") {
    await activate();
    readiness = await waitForSourceReady(tab.id, source, 15_000);
  }
  readiness.waitMs = Date.now() - startedAt;
  if (readiness.state !== "feed_ready") {
    await restoreTabFocus(previousActiveTabId, tab.id);
    throw new Error(
      `${sourceLabel(source)} source readiness failed: ${readiness.state} ` +
      `(${readiness.selectorCandidateCount} selector candidates, ` +
      `${readiness.visibleSelectorCandidateCount ?? 0} visible, ` +
      `${readiness.windowVisibleSelectorCandidateCount ?? 0} window-visible, ` +
      `semantic=${readiness.semanticSelectorCandidateCount ?? 0}, ` +
      `action=${readiness.actionAnchoredCandidateCount ?? 0}, ` +
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

async function waitForSourceReady(tabId, source, timeoutMs) {
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
    if (["feed_ready", "login_required", "wrong_page"].includes(latest.state)) break;
    await delay(250);
  }
  return { ...latest, waitMs: Date.now() - startedAt };
}

async function probeSourceReadiness(tabId, source) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_PROBE_SOURCE_READY",
      source,
    });
    if (response?.ok && response.readiness) return response.readiness;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: SOURCE_SCRIPT_FILES,
    });
  }
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "AKU_BROWSER_PROBE_SOURCE_READY",
    source,
  });
  return response?.readiness ?? {
    state: "page_shell",
    selectorCandidateCount: 0,
    visibleSelectorCandidateCount: 0,
  };
}

async function restoreTabFocus(previousActiveTabId, sourceTabId) {
  if (!previousActiveTabId || previousActiveTabId === sourceTabId) return;
  try {
    await chrome.tabs.update(previousActiveTabId, { active: true });
  } catch {
    // The user may have closed or moved the previous tab during the bounded capture.
  }
}

function observationBlockCount(observation) {
  return (observation?.snapshots ?? []).reduce(
    (sum, snapshot) => sum + (snapshot.blocks?.length ?? 0),
    0,
  );
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
        timeoutId = setTimeout(() => {
          reject(new Error("AkuBridge content capture exceeded its bounded response deadline."));
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
  const manifest = chrome.runtime.getManifest();
  return {
    bridgeId: BRIDGE_ID,
    extensionVersion: manifest.version,
    runtimeRevision: "bridge-diagnostics-v1",
    contractVersion: BRIDGE_CONTRACT_VERSION,
    manifestVersion: manifest.manifest_version,
    sources: ["x", "linkedin"],
    actions: [
      "probe_readiness",
      "collect_visible",
      "detect_pending_content",
      "report_adapter_health",
      "extract_source_semantics",
      "report_frontier",
      "manage_source_tab_lifecycle",
      "report_source_events",
    ],
    authority: "read_only_bounded",
    captureLimits: { maxScrolls: 2, maxSnapshots: 3, maxBlocksPerSnapshot: 20 },
  };
}
