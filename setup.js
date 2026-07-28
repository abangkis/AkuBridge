import {
  AKU_BROWSER_LOOPBACK_ORIGIN,
  createChromeNativeRuntimeClient,
  probeCompatibleLoopbackRuntime,
} from "./native-runtime-client.js";
import {
  originsForSources,
  sourceAccessDefinitions,
  sourcesForGrantedOrigins,
} from "./source-access-policy.js";

const RUNTIME_INSTALLER_URL =
  "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeSetup.exe";
const client = createChromeNativeRuntimeClient(chrome);
const manifest = chrome.runtime.getManifest();
const productVersion = manifest.version_name || manifest.version;
const summary = document.querySelector("#summary");
const detail = document.querySelector("#detail");
const retry = document.querySelector("#retry");
const install = document.querySelector("#install");
const open = document.querySelector("#open");
const installerNote = document.querySelector("#installer-note");
const sourceOptions = document.querySelector("#source-options");
const saveSourceAccess = document.querySelector("#save-source-access");
const sourceAccessStatus = document.querySelector("#source-access-status");
let grantedSourceIds = new Set();

retry.addEventListener("click", () => void reconcile());
install.addEventListener("click", () => {
  chrome.tabs.create({ url: RUNTIME_INSTALLER_URL, active: true });
});
open.addEventListener("click", () => {
  chrome.tabs.create({ url: `${AKU_BROWSER_LOOPBACK_ORIGIN}/`, active: true });
});
sourceOptions.addEventListener("change", updateSourceAccessButton);
saveSourceAccess.addEventListener("click", () => void saveSelectedSourceAccess());

void reconcile({ statusOnly: true });
void renderSourceAccess();

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
  install.hidden = true;
  open.hidden = true;
  installerNote.hidden = true;
  summary.textContent = "Memeriksa runtime AkuBrowser...";
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
  const installRequired = outcome.state === "runtime_install_required";
  install.hidden = !installRequired;
  installerNote.hidden = !installRequired;
}

function renderReady(message) {
  retry.disabled = false;
  summary.textContent = "AkuBrowser siap.";
  detail.textContent = message;
  install.hidden = true;
  open.hidden = false;
  installerNote.hidden = true;
}

async function renderSourceAccess() {
  const permissions = await chrome.permissions.getAll();
  const granted = new Set(sourcesForGrantedOrigins(permissions.origins));
  grantedSourceIds = granted;
  for (const input of sourceOptions.querySelectorAll("input[type=checkbox]")) {
    input.checked = granted.has(input.value);
  }
  sourceAccessStatus.textContent = granted.size > 0
    ? `Aktif: ${sourceAccessDefinitions()
      .filter((source) => granted.has(source.id))
      .map((source) => source.displayName)
      .join(", ")}.`
    : "Belum ada sumber sosial yang diizinkan.";
  updateSourceAccessButton();
}

function updateSourceAccessButton() {
  const selected = new Set([...sourceOptions.querySelectorAll("input[type=checkbox]:checked")]
    .map((input) => input.value));
  const unchanged = selected.size === grantedSourceIds.size
    && [...selected].every((source) => grantedSourceIds.has(source));
  saveSourceAccess.textContent = selected.size > 0
    ? "Saya setuju & aktifkan"
    : "Cabut semua izin sumber";
  saveSourceAccess.disabled = unchanged;
}

async function saveSelectedSourceAccess() {
  const selected = [...sourceOptions.querySelectorAll("input[type=checkbox]:checked")]
    .map((input) => input.value);
  const selectedOrigins = originsForSources(selected);
  saveSourceAccess.disabled = true;
  sourceAccessStatus.textContent = "Menunggu persetujuan Chrome...";
  try {
    if (selectedOrigins.length > 0) {
      const granted = await chrome.permissions.request({ origins: selectedOrigins });
      if (!granted) {
        sourceAccessStatus.textContent = "Izin tidak diberikan. Tidak ada sumber baru yang dibaca.";
        return;
      }
    }
    const allOrigins = originsForSources(sourceAccessDefinitions().map((source) => source.id));
    const removedOrigins = allOrigins.filter((origin) => !selectedOrigins.includes(origin));
    if (removedOrigins.length > 0) {
      await chrome.permissions.remove({ origins: removedOrigins });
    }
    const response = await chrome.runtime.sendMessage({
      type: "AKU_BROWSER_RECONCILE_SOURCE_ACCESS",
    });
    if (!response?.ok) throw new Error(response?.message || "Source access reconciliation failed.");
    await renderSourceAccess();
  } catch {
    sourceAccessStatus.textContent = "Pilihan belum dapat disimpan. Coba lagi.";
  } finally {
    saveSourceAccess.disabled = false;
  }
}
