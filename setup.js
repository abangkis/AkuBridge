import {
  AKU_BROWSER_LOOPBACK_ORIGIN,
  createChromeNativeRuntimeClient,
  probeCompatibleLoopbackRuntime,
} from "./native-runtime-client.js";
import {
  SOURCE_ACCESS_SELECTION_KEY,
  originsForSources,
  setupSelectedSources,
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
const componentsStep = document.querySelector("#step-components");
const componentsStatusBadge = document.querySelector("#components-status-badge");
const runtimeStatusBadge = document.querySelector("#runtime-status-badge");
const codexConfirmation = document.querySelector("#codex-confirmation");
const codexStatusBadge = document.querySelector("#codex-status-badge");
const permissionStep = document.querySelector("#step-permissions");
const permissionStatusBadge = document.querySelector("#permission-status-badge");
const finishStep = document.querySelector("#step-finish");
const finishDetail = document.querySelector("#finish-detail");
const sourceOptions = document.querySelector("#source-options");
const saveSourceAccess = document.querySelector("#save-source-access");
const sourceAccessStatus = document.querySelector("#source-access-status");
let grantedSourceIds = new Set();
let sourceSelectionRecorded = false;
let runtimeReady = false;
let codexConfirmed = false;

retry.addEventListener("click", () => void reconcile());
install.addEventListener("click", () => {
  chrome.tabs.create({ url: RUNTIME_INSTALLER_URL, active: true });
});
open.addEventListener("click", () => {
  chrome.tabs.create({ url: `${AKU_BROWSER_LOOPBACK_ORIGIN}/`, active: true });
});
codexConfirmation.addEventListener("change", () => void saveCodexConfirmation());
sourceOptions.addEventListener("change", updateSourceAccessButton);
saveSourceAccess.addEventListener("click", () => void saveSelectedSourceAccess());

void reconcile({ statusOnly: true });
void renderCodexConfirmation();
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
      renderReady("A compatible portable AkuBrowser Runtime was detected and is ready.");
      return;
    }
  }
  renderOutcome(outcome);
}

function setChecking() {
  runtimeReady = false;
  retry.disabled = true;
  install.hidden = true;
  installerNote.hidden = true;
  summary.textContent = "Checking AkuBrowser Runtime...";
  detail.textContent = "This check contacts only the registered host and the local AkuBrowser endpoint.";
  setRuntimeBadge("Checking");
  updateTimelineState();
}

function renderOutcome(outcome) {
  retry.disabled = false;
  const views = {
    runtime_install_required: [
      "AkuBrowser Runtime is not installed.",
      "The extension is ready. Install the companion runtime, then select Check again.",
    ],
    runtime_updating: [
      "AkuBrowser Runtime is updating.",
      "Wait for the update to finish, then check again.",
    ],
    runtime_busy: [
      "AkuBrowser Runtime is busy.",
      "Wait for the active work to finish, then check again.",
    ],
    runtime_restart_required: [
      "Chrome needs to restart.",
      "Close every Chrome window, reopen Chrome, and then check again.",
    ],
    runtime_incompatible: [
      "The runtime version is incompatible.",
      "Repair or reinstall the AkuBrowser companion runtime.",
    ],
    runtime_failed: [
      "AkuBrowser Runtime could not start.",
      "Check again. If the problem continues, repair the companion runtime.",
    ],
  };
  if (outcome.state === "runtime_ready") {
    renderReady("AkuBrowser Runtime is ready.");
    return;
  }
  const [title, explanation] = views[outcome.state] ?? views.runtime_failed;
  runtimeReady = false;
  summary.textContent = title;
  detail.textContent = explanation;
  const installRequired = outcome.state === "runtime_install_required";
  install.hidden = !installRequired;
  installerNote.hidden = !installRequired;
  setRuntimeBadge(installRequired ? "Not installed" : "Needs attention", "warning");
  updateTimelineState();
}

function renderReady(message) {
  runtimeReady = true;
  retry.disabled = false;
  summary.textContent = "The AkuBrowser Runtime bundle is ready.";
  detail.textContent = message;
  install.hidden = true;
  installerNote.hidden = true;
  setRuntimeBadge("Ready", "ready");
  updateTimelineState();
}

async function renderSourceAccess() {
  const [permissions, stored] = await Promise.all([
    chrome.permissions.getAll(),
    chrome.storage.local.get(SOURCE_ACCESS_SELECTION_KEY),
  ]);
  const granted = new Set(sourcesForGrantedOrigins(permissions.origins));
  sourceSelectionRecorded = stored?.[SOURCE_ACCESS_SELECTION_KEY]?.schemaVersion === 1
    && Array.isArray(stored[SOURCE_ACCESS_SELECTION_KEY].selectedSources);
  const selected = new Set(setupSelectedSources(
    [...granted],
    stored?.[SOURCE_ACCESS_SELECTION_KEY],
  ));
  grantedSourceIds = granted;
  for (const input of sourceOptions.querySelectorAll("input[type=checkbox]")) {
    input.checked = selected.has(input.value);
  }
  sourceAccessStatus.textContent = granted.size > 0
    ? `Active: ${sourceAccessDefinitions()
      .filter((source) => granted.has(source.id))
      .map((source) => source.displayName)
      .join(", ")}.`
    : "No social sources are currently allowed.";
  updateSourceAccessButton();
  updateTimelineState();
}

function updateSourceAccessButton() {
  const selected = new Set([...sourceOptions.querySelectorAll("input[type=checkbox]:checked")]
    .map((input) => input.value));
  const unchanged = sourceSelectionRecorded
    && selected.size === grantedSourceIds.size
    && [...selected].every((source) => grantedSourceIds.has(source));
  saveSourceAccess.textContent = selected.size > 0
    ? "I agree & enable"
    : "Revoke all source access";
  saveSourceAccess.disabled = unchanged;
}

async function renderCodexConfirmation() {
  const stored = await chrome.storage.local.get("akuBrowserCodexPrerequisiteConfirmed");
  codexConfirmed = stored.akuBrowserCodexPrerequisiteConfirmed === true;
  codexConfirmation.checked = codexConfirmed;
  setCodexBadge(codexConfirmed);
  updateTimelineState();
}

async function saveCodexConfirmation() {
  codexConfirmed = codexConfirmation.checked;
  await chrome.storage.local.set({
    akuBrowserCodexPrerequisiteConfirmed: codexConfirmed,
  });
  setCodexBadge(codexConfirmed);
  updateTimelineState();
}

function setRuntimeBadge(label, state = "") {
  runtimeStatusBadge.textContent = label;
  runtimeStatusBadge.classList.toggle("is-ready", state === "ready");
  runtimeStatusBadge.classList.toggle("is-warning", state === "warning");
}

function setCodexBadge(confirmed) {
  codexStatusBadge.textContent = confirmed ? "Confirmed" : "Manual confirmation";
  codexStatusBadge.classList.toggle("is-ready", confirmed);
  codexStatusBadge.classList.toggle("is-warning", !confirmed);
}

function setStepState(step, state) {
  step.classList.toggle("is-active", state === "active");
  step.classList.toggle("is-complete", state === "complete");
}

function updateTimelineState() {
  const componentsReady = runtimeReady && codexConfirmed;
  const permissionsReady = grantedSourceIds.size > 0;
  setStepState(componentsStep, componentsReady ? "complete" : "active");
  setStepState(permissionStep, permissionsReady ? "complete" : componentsReady ? "active" : "");
  setStepState(finishStep, componentsReady && permissionsReady ? "complete" : "");

  componentsStatusBadge.textContent = componentsReady ? "Ready" : "Needs completion";
  componentsStatusBadge.classList.toggle("is-ready", componentsReady);
  componentsStatusBadge.classList.toggle("is-warning", !componentsReady);

  permissionStatusBadge.textContent = permissionsReady
    ? `${grantedSourceIds.size} ${grantedSourceIds.size === 1 ? "source" : "sources"} active`
    : "None selected";
  permissionStatusBadge.classList.toggle("is-ready", permissionsReady);

  const ready = componentsReady && permissionsReady;
  open.disabled = !ready;
  finishDetail.textContent = ready
    ? "All components are ready and your source access is saved."
    : !componentsReady
      ? "Finish installing the runtime and confirm that Codex is ready."
      : "Choose at least one source to start building your timeline.";
}

async function saveSelectedSourceAccess() {
  const selected = [...sourceOptions.querySelectorAll("input[type=checkbox]:checked")]
    .map((input) => input.value);
  const selectedOrigins = originsForSources(selected);
  saveSourceAccess.disabled = true;
  sourceAccessStatus.textContent = "Waiting for Chrome permission...";
  try {
    if (selectedOrigins.length > 0) {
      const granted = await chrome.permissions.request({ origins: selectedOrigins });
      if (!granted) {
        sourceAccessStatus.textContent = "Permission was not granted. No new source will be read.";
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
    await chrome.storage.local.set({
      [SOURCE_ACCESS_SELECTION_KEY]: {
        schemaVersion: 1,
        selectedSources: selected,
        confirmedAt: new Date().toISOString(),
      },
    });
    await renderSourceAccess();
  } catch {
    sourceAccessStatus.textContent = "Your selection could not be saved. Try again.";
  } finally {
    updateSourceAccessButton();
  }
}
