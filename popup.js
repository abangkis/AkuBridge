import { AKU_BROWSER_LOOPBACK_ORIGIN } from "./native-runtime-client.js";

document.querySelector("#open-akubrowser").addEventListener("click", () => {
  void openTab(`${AKU_BROWSER_LOOPBACK_ORIGIN}/`);
});

document.querySelector("#open-setup").addEventListener("click", () => {
  void openTab(chrome.runtime.getURL("setup.html"));
});

async function openTab(url) {
  await chrome.tabs.create({ url, active: true });
  globalThis.close();
}
