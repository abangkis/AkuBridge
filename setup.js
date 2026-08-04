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
import { simulatedRuntimeOutcome } from "./setup-runtime-simulation.js";
import {
  detectSetupPlatform,
  SETUP_PLATFORMS,
} from "./setup-platform.js";
import {
  RUNTIME_SETUP_ACTIONS,
  runtimeCheckTimeoutMs,
  runtimeSetupView,
} from "./setup-runtime-view.js";

const RUNTIME_INSTALLER_URL =
  "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeSetup.exe";
const RUNTIME_INSTALLER_ATTEMPT_KEY = "akuBrowser.runtimeInstallerAttempted.v1";
const simulatedOutcome = simulatedRuntimeOutcome(globalThis.location.search);
const setupPlatform = detectSetupPlatform(globalThis.navigator);
const windowsRuntimeInstallerAvailable = setupPlatform === SETUP_PLATFORMS.WINDOWS;
const client = createChromeNativeRuntimeClient(chrome);
const manifest = chrome.runtime.getManifest();
const productVersion = manifest.version_name || manifest.version;
const RUNTIME_PORTABLE_BUNDLE_URL =
  `https://github.com/abangkis/AkuBrowser/releases/download/v${productVersion}/AkuBrowser-${productVersion}-windows-x64.zip`;
const summary = document.querySelector("#summary");
const detail = document.querySelector("#detail");
const runtimeAction = document.querySelector("#runtime-action");
const open = document.querySelector("#open");
const installerNote = document.querySelector("#installer-note");
const installerNoteTitle = document.querySelector("#installer-note-title");
const installerStepOpen = document.querySelector("#installer-step-open");
const installerStepRun = document.querySelector("#installer-step-run");
const installerStepCheck = document.querySelector("#installer-step-check");
const windowsAntivirusNote = document.querySelector("#windows-antivirus-note");
const manualRuntimeFallback = document.querySelector("#manual-runtime-fallback");
const manualBundleDownload = document.querySelector("#manual-bundle-download");
const runtimePlatformDescription = document.querySelector("#runtime-platform-description");
const codexPlatformDescription = document.querySelector("#codex-platform-description");
const codexDownload = document.querySelector("#codex-download");
const componentsStep = document.querySelector("#step-components");
const componentsStatusBadge = document.querySelector("#components-status-badge");
const runtimeStatusBadge = document.querySelector("#runtime-status-badge");
const runtimeExecutableLocation = document.querySelector("#runtime-executable-location");
const runtimeExecutablePath = document.querySelector("#runtime-executable-path");
const runtimeExecutableLocationHint = document.querySelector("#runtime-executable-location-hint");
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
let runtimeInstallerAttempted = globalThis.sessionStorage.getItem(RUNTIME_INSTALLER_ATTEMPT_KEY) === "1";
let currentRuntimeAction = RUNTIME_SETUP_ACTIONS.NONE;
let currentRuntimeActionRetries = false;
let runtimeRetryAttempts = 0;

applyPlatformCopy();

runtimeAction.addEventListener("click", () => void performRuntimeAction());
open.addEventListener("click", () => {
  chrome.tabs.create({ url: `${AKU_BROWSER_LOOPBACK_ORIGIN}/`, active: true });
});
codexConfirmation.addEventListener("change", () => void saveCodexConfirmation());
sourceOptions.addEventListener("change", updateSourceAccessButton);
saveSourceAccess.addEventListener("click", () => void saveSelectedSourceAccess());

renderOutcome(simulatedOutcome ?? { state: "runtime_unchecked" });
void renderCodexConfirmation();
void renderSourceAccess();

async function performRuntimeAction() {
  if (currentRuntimeAction === RUNTIME_SETUP_ACTIONS.CHECK) {
    runtimeRetryAttempts = 0;
    await reconcile({
      statusOnly: true,
      timeoutMs: runtimeCheckTimeoutMs(runtimeRetryAttempts),
    });
    return;
  }
  if (currentRuntimeAction === RUNTIME_SETUP_ACTIONS.INSTALL) {
    await downloadRuntimeInstaller();
    return;
  }
  if (currentRuntimeAction === RUNTIME_SETUP_ACTIONS.ENSURE) {
    runtimeRetryAttempts = currentRuntimeActionRetries
      ? runtimeRetryAttempts + 1
      : 0;
    await reconcile({
      timeoutMs: runtimeCheckTimeoutMs(runtimeRetryAttempts),
    });
    return;
  }
  if (currentRuntimeAction === RUNTIME_SETUP_ACTIONS.STOP) {
    runtimeRetryAttempts = 0;
    await reconcile({
      stopOnly: true,
      timeoutMs: runtimeCheckTimeoutMs(runtimeRetryAttempts),
    });
  }
}

async function reconcile({
  statusOnly = false,
  stopOnly = false,
  timeoutMs = runtimeCheckTimeoutMs(0),
} = {}) {
  if (simulatedOutcome) {
    renderOutcome(simulatedOutcome);
    detail.textContent = `${detail.textContent} Simulation mode uses the real runtime action controls.`;
    return;
  }
  setChecking(timeoutMs, { stopping: stopOnly });
  const outcome = stopOnly
    ? await client.shutdownIfIdle({ trigger: "setup_stop", timeoutMs })
    : statusOnly
      ? await client.status({ trigger: "setup_check", timeoutMs })
      : await client.ensureRuntime({ trigger: "setup_action", timeoutMs });
  if (!stopOnly && outcome.state !== "runtime_ready") {
    const portableRuntimeReady = await probeCompatibleLoopbackRuntime({ productVersion });
    if (portableRuntimeReady) {
      renderReady("A compatible portable AkuBrowser Runtime was detected and is ready.", {
        runtimeSource: "portable",
      });
      return;
    }
  }
  renderOutcome(outcome);
}

async function downloadRuntimeInstaller() {
  if (!windowsRuntimeInstallerAvailable) return;
  runtimeAction.disabled = true;
  try {
    manualRuntimeFallback.hidden = true;
    await chrome.tabs.create({ url: RUNTIME_INSTALLER_URL, active: true });
    runtimeInstallerAttempted = true;
    globalThis.sessionStorage.setItem(RUNTIME_INSTALLER_ATTEMPT_KEY, "1");
    currentRuntimeAction = RUNTIME_SETUP_ACTIONS.CHECK;
    runtimeAction.textContent = "Check runtime";
    installerNoteTitle.textContent = "Download started — run the installer next";
    summary.textContent = "The runtime installer is downloading.";
    detail.textContent = [
      "Chrome cannot run downloaded applications automatically.",
      "Open AkuBrowserRuntimeSetup.exe, finish Windows setup, return here, then select Check runtime.",
    ].join(" ");
  } catch {
    summary.textContent = "The runtime installer could not be downloaded.";
    detail.textContent = "Use the matching manual Windows bundle below. Your setup progress has not changed.";
    manualRuntimeFallback.hidden = false;
  } finally {
    runtimeAction.disabled = false;
  }
}

function applyPlatformCopy() {
  document.documentElement.dataset.platform = setupPlatform;
  windowsAntivirusNote.hidden = !windowsRuntimeInstallerAvailable;
  manualBundleDownload.href = RUNTIME_PORTABLE_BUNDLE_URL;
  if (setupPlatform === SETUP_PLATFORMS.WINDOWS) {
    runtimePlatformDescription.textContent = [
      "The Windows runtime installer includes AkuSidecar, the Native Messaging Host,",
      "and the C2PA verifier. You install and prepare Codex App separately.",
    ].join(" ");
    codexPlatformDescription.textContent = [
      "Install Codex App for Windows, sign in, and make sure Codex is ready.",
      "AkuBrowser never receives your Codex credentials.",
    ].join(" ");
    return;
  }

  const platformLabel = setupPlatform === SETUP_PLATFORMS.MACOS
    ? "macOS"
    : setupPlatform === SETUP_PLATFORMS.LINUX
      ? "Linux"
      : "this platform";
  runtimePlatformDescription.textContent = [
    `The one-click AkuBrowser Runtime installer is not available for ${platformLabel} yet.`,
    "This setup can still check a compatible runtime that was installed separately.",
  ].join(" ");
  installerNoteTitle.textContent = `Runtime installation is not available for ${platformLabel} yet`;
  installerStepOpen.textContent = "Do not download the Windows .exe on this device.";
  installerStepRun.textContent = "Install a compatible AkuBrowser Runtime using the platform release instructions.";
  installerStepCheck.textContent = "Return here and select Check runtime.";
  codexPlatformDescription.textContent = setupPlatform === SETUP_PLATFORMS.MACOS
    ? "Install the desktop app for macOS, sign in, and make sure Codex is ready. AkuBrowser never receives your credentials."
    : "Prepare a supported Codex installation and sign in. AkuBrowser never receives your credentials.";
  codexDownload.href = setupPlatform === SETUP_PLATFORMS.MACOS
    ? "https://chatgpt.com/download/"
    : "https://openai.com/codex/";
  codexDownload.textContent = setupPlatform === SETUP_PLATFORMS.MACOS
    ? "Download for macOS"
    : "View Codex options";
}

function configureInstallerGuidance(state) {
  if (setupPlatform !== SETUP_PLATFORMS.WINDOWS) return;
  if (state === "runtime_incompatible") {
    installerNoteTitle.textContent = "Stop the older portable runtime before retrying";
    installerStepOpen.textContent = "Close the AkuBrowser portable terminal or development runtime that is still running.";
    installerStepRun.textContent = "Keep the installed Windows Runtime; reinstall it only if the mismatch remains.";
    installerStepCheck.textContent = "Return here and select Try again.";
    return;
  }
  installerNoteTitle.textContent = "Run the Windows installer after downloading it";
  installerStepOpen.innerHTML = "Open <code>AkuBrowserRuntimeSetup.exe</code> when the download finishes.";
  installerStepRun.textContent = "Approve the Windows prompt and complete the setup.";
  installerStepCheck.textContent = "Return here and select Check runtime.";
}

function setChecking(timeoutMs, { stopping = false } = {}) {
  runtimeReady = false;
  currentRuntimeAction = RUNTIME_SETUP_ACTIONS.NONE;
  runtimeAction.textContent = stopping ? "Stopping..." : "Checking...";
  runtimeAction.disabled = true;
  installerNote.hidden = true;
  manualRuntimeFallback.hidden = true;
  windowsAntivirusNote.hidden = true;
  summary.textContent = stopping
    ? "Stopping AkuBrowser Runtime..."
    : "Checking AkuBrowser Runtime...";
  detail.textContent = [
    "This check contacts only the registered host and the local AkuBrowser endpoint.",
    `It will stop after ${Math.round(timeoutMs / 1_000)} seconds if the host does not respond.`,
  ].join(" ");
  setRuntimeBadge("Checking");
  updateTimelineState();
}

function renderOutcome(outcome) {
  if (outcome.state === "runtime_ready") {
    runtimeRetryAttempts = 0;
    runtimeInstallerAttempted = false;
    globalThis.sessionStorage.removeItem(RUNTIME_INSTALLER_ATTEMPT_KEY);
  }
  const runtimeView = runtimeSetupView(outcome, {
    windowsInstallerAvailable: windowsRuntimeInstallerAvailable,
    runtimeInstallerAttempted,
  });
  configureInstallerGuidance(outcome.state);
  runtimeReady = runtimeView.runtimeReady;
  currentRuntimeAction = runtimeView.actionKind;
  currentRuntimeActionRetries = runtimeView.retryAction;
  summary.textContent = runtimeView.summary;
  detail.textContent = runtimeView.detail;
  runtimeAction.textContent = runtimeView.actionLabel;
  runtimeAction.disabled = runtimeView.actionDisabled;
  installerNote.hidden = !runtimeView.showInstallerNote;
  windowsAntivirusNote.hidden = !runtimeView.showSecurityNotice;
  manualRuntimeFallback.hidden = !runtimeView.showManualFallback;
  runtimeExecutablePath.textContent = runtimeView.executableLocation;
  runtimeExecutableLocationHint.textContent = runtimeView.executableLocationHint;
  runtimeExecutableLocation.hidden = !runtimeView.executableLocation;
  setRuntimeBadge(runtimeView.badge, runtimeView.badgeState);
  updateTimelineState();
}

function renderReady(message, { runtimeSource } = {}) {
  runtimeInstallerAttempted = false;
  globalThis.sessionStorage.removeItem(RUNTIME_INSTALLER_ATTEMPT_KEY);
  renderOutcome({ state: "runtime_ready", runtimeSource });
  detail.textContent = message;
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
