import {
  AKU_BROWSER_LOOPBACK_ORIGIN,
  NATIVE_RUNTIME_STATE_KEY,
} from "./native-runtime-client.js";
import { nativeRuntimeStatusView } from "./native-runtime-status-view.js";

void showRuntimeStatus();

document.querySelector("#open-akubrowser").addEventListener("click", () => {
  void openTab(`${AKU_BROWSER_LOOPBACK_ORIGIN}/`);
});

async function openTab(url) {
  await chrome.tabs.create({ url, active: true });
  globalThis.close();
}

async function showRuntimeStatus() {
  const stored = await chrome.storage.local.get(NATIVE_RUNTIME_STATE_KEY).catch(() => ({}));
  const view = nativeRuntimeStatusView(stored?.[NATIVE_RUNTIME_STATE_KEY]);
  if (!view) return;
  const container = document.querySelector("#runtime-status");
  container.dataset.tone = view.tone;
  document.querySelector("#runtime-status-title").textContent = view.title;
  document.querySelector("#runtime-status-detail").textContent = view.detail;
  container.hidden = false;
}
