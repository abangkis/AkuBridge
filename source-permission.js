import { AKU_BROWSER_LOOPBACK_ORIGIN } from "./native-runtime-client.js";
import {
  SOURCE_ACCESS_SELECTION_KEY,
  SOURCE_ACCESS_SELECTION_SCHEMA_VERSION,
  sourceAccessDefinition,
} from "./source-access-policy.js";
import { sourceDefinition } from "./source-catalog.js";

const source = new URLSearchParams(globalThis.location.search).get("source") ?? "";
const access = sourceAccessDefinition(source);
const catalog = sourceDefinition(source);
const allowButton = document.querySelector("#allow-source");
const backButton = document.querySelector("#back-to-akubrowser");
const status = document.querySelector("#permission-status");

backButton.addEventListener("click", () => {
  globalThis.location.replace(`${AKU_BROWSER_LOOPBACK_ORIGIN}/`);
});

if (!access || !catalog?.feedUrl) {
  document.querySelector("#permission-title").textContent = "Unknown source";
  document.querySelector("#permission-intro").textContent = "AkuBrowser did not recognize this source request.";
  document.querySelector(".permission-card").hidden = true;
  allowButton.hidden = true;
  showStatus("Return to AkuBrowser and choose a supported source.", true);
} else {
  document.title = `Allow ${access.displayName} · AkuBrowser`;
  document.querySelector("#permission-title").textContent = `Allow ${access.displayName} access`;
  document.querySelector("#permission-intro").textContent = `Grant access before AkuBrowser opens ${access.displayName}.`;
  document.querySelector("#source-name").textContent = access.displayName;
  document.querySelector("#source-mark").textContent = access.displayName.slice(0, 2).toUpperCase();
  document.querySelector("#source-origin").textContent = access.origins.join("\n");
  allowButton.addEventListener("click", () => void allowAndContinue());
}

async function allowAndContinue() {
  allowButton.disabled = true;
  showStatus("Waiting for Chrome permission…");
  try {
    const granted = await chrome.permissions.request({ origins: access.origins });
    if (!granted) {
      showStatus("Permission was not granted. AkuBrowser did not open or read this source.", true);
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: "AKU_BROWSER_RECONCILE_SOURCE_ACCESS" });
    if (!response?.ok) throw new Error(response?.message || "Source access reconciliation failed.");
    const stored = await chrome.storage.local.get(SOURCE_ACCESS_SELECTION_KEY);
    const previous = stored?.[SOURCE_ACCESS_SELECTION_KEY]?.selectedSources;
    const selectedSources = [...new Set([
      ...(Array.isArray(previous) ? previous : []),
      source,
    ])];
    await chrome.storage.local.set({
      [SOURCE_ACCESS_SELECTION_KEY]: {
        schemaVersion: SOURCE_ACCESS_SELECTION_SCHEMA_VERSION,
        selectedSources,
        confirmedAt: new Date().toISOString(),
      },
    });
    showStatus(`Access granted. Opening ${access.displayName}…`);
    globalThis.location.replace(catalog.feedUrl);
  } catch (error) {
    showStatus(String(error?.message ?? error), true);
  } finally {
    allowButton.disabled = false;
  }
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
