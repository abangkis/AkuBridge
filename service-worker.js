import { chooseSourceTab, expectedFeedUrl } from "./source-tab-policy.js";

const AKU_BROWSER_ORIGIN = "http://127.0.0.1:47821";
const BRIDGE_ID = "aku-bridge-chrome-mv3-v0";
const BRIDGE_CONTRACT_VERSION = "aku-browser.bridge.v1";

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${AKU_BROWSER_ORIGIN}/`, active: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "AKU_BROWSER_DISPATCH") return undefined;
  if (!sender.url?.startsWith(`${AKU_BROWSER_ORIGIN}/`)) {
    sendResponse({ ok: false, message: "Dispatch rejected: invalid AkuBrowser origin." });
    return false;
  }
  dispatchRun(message)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
  return true;
});

async function dispatchRun(message) {
  assertEndpoint(message.endpoint);
  const command = await claimCommand(message.endpoint, message.token, message.runId);
  if (!command) throw new Error("No queued browser command was available for this run.");

  try {
    const tab = await findOrOpenSourceTab(
      command.payload.source,
      command.payload.mode,
      command.payload.openIfMissing,
    );
    const response = await collectFromTab(tab.id, command.payload);
    if (!response?.ok) throw new Error(response?.message || "Source content script failed.");
    await postBridgeResult(
      message.endpoint,
      message.token,
      command.id,
      "observation",
      { runId: message.runId, observation: response.observation },
    );
  } catch (error) {
    await postBridgeResult(
      message.endpoint,
      message.token,
      command.id,
      "failure",
      { runId: message.runId, error: { message: String(error?.message ?? error) } },
    ).catch(() => undefined);
    throw error;
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
  if (selected) return selected;
  if (!openIfMissing) {
    const expectation = mode === "catch_up" ? ` feed tab (${expectedFeedUrl(source)})` : " tab";
    throw new Error(`No open, rendered ${source}${expectation} was found.`);
  }

  const url = expectedFeedUrl(source);
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(tab.id, 20_000);
  return chrome.tabs.get(tab.id);
}

async function collectFromTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_COLLECT_VISIBLE",
      payload,
    });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    return chrome.tabs.sendMessage(tabId, {
      type: "AKU_BROWSER_COLLECT_VISIBLE",
      payload,
    });
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
