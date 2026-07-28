import {
  AKU_BROWSER_LOOPBACK_ORIGIN,
  createChromeNativeRuntimeClient,
  probeCompatibleLoopbackRuntime,
} from "./native-runtime-client.js";

const client = createChromeNativeRuntimeClient(chrome);
const manifest = chrome.runtime.getManifest();
const productVersion = manifest.version_name || manifest.version;
const summary = document.querySelector("#summary");
const detail = document.querySelector("#detail");
const retry = document.querySelector("#retry");
const open = document.querySelector("#open");
const installerNote = document.querySelector("#installer-note");

retry.addEventListener("click", () => void reconcile());
open.addEventListener("click", () => {
  chrome.tabs.create({ url: `${AKU_BROWSER_LOOPBACK_ORIGIN}/`, active: true });
});

void reconcile({ statusOnly: true });

async function reconcile({ statusOnly = false } = {}) {
  setChecking();
  let outcome = await client.status({ trigger: "setup" });
  if (!statusOnly && outcome.state !== "runtime_install_required") {
    outcome = await client.ensureRuntime({ trigger: "setup_retry" });
  }
  if (outcome.state !== "runtime_ready") {
    const portableRuntimeReady = await probeCompatibleLoopbackRuntime({ productVersion });
    if (portableRuntimeReady) {
      renderReady("Runtime portable AkuBrowser terdeteksi dan siap digunakan.");
      return;
    }
  }
  renderOutcome(outcome);
}

function setChecking() {
  retry.disabled = true;
  open.hidden = true;
  installerNote.hidden = true;
  summary.textContent = "Memeriksa runtime AkuBrowser…";
  detail.textContent = "Pemeriksaan ini hanya menghubungi host terdaftar dan endpoint lokal AkuBrowser.";
}

function renderOutcome(outcome) {
  retry.disabled = false;
  const views = {
    runtime_install_required: [
      "Runtime AkuBrowser belum terpasang.",
      "Extension sudah siap. Pasang companion runtime, lalu klik Periksa lagi.",
    ],
    runtime_updating: [
      "Runtime AkuBrowser sedang diperbarui.",
      "Tunggu proses selesai, lalu periksa kembali.",
    ],
    runtime_busy: [
      "Runtime AkuBrowser sedang sibuk.",
      "Tunggu pekerjaan aktif selesai, lalu periksa kembali.",
    ],
    runtime_restart_required: [
      "Chrome perlu dimulai ulang.",
      "Tutup seluruh jendela Chrome, buka kembali, lalu periksa lagi.",
    ],
    runtime_incompatible: [
      "Versi runtime tidak kompatibel.",
      "Perbaiki atau pasang ulang companion runtime AkuBrowser.",
    ],
    runtime_failed: [
      "Runtime AkuBrowser belum dapat dijalankan.",
      "Coba periksa lagi. Jika masalah berlanjut, companion runtime perlu diperbaiki.",
    ],
  };
  if (outcome.state === "runtime_ready") {
    renderReady("Runtime AkuBrowser siap digunakan.");
    return;
  }
  const [title, explanation] = views[outcome.state] ?? views.runtime_failed;
  summary.textContent = title;
  detail.textContent = explanation;
  installerNote.hidden = outcome.state !== "runtime_install_required";
}

function renderReady(message) {
  retry.disabled = false;
  summary.textContent = "AkuBrowser siap.";
  detail.textContent = message;
  open.hidden = false;
  installerNote.hidden = true;
}
