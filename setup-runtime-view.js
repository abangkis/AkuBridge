export const RUNTIME_SETUP_ACTIONS = Object.freeze({
  CHECK: "check",
  INSTALL: "install",
  ENSURE: "ensure",
  STOP: "stop",
  RESOLVE_CONFLICT: "resolve_conflict",
  NONE: "none",
});
export const RUNTIME_CHECK_TIMEOUT_BASE_MS = 60_000;
export const RUNTIME_CHECK_TIMEOUT_RETRY_STEP_MS = 10_000;

export function runtimeCheckTimeoutMs(retryAttempt = 0) {
  const normalizedAttempt = Number.isInteger(retryAttempt) && retryAttempt > 0
    ? retryAttempt
    : 0;
  return RUNTIME_CHECK_TIMEOUT_BASE_MS
    + (normalizedAttempt * RUNTIME_CHECK_TIMEOUT_RETRY_STEP_MS);
}

export function runtimeSetupView(outcome, {
  windowsInstallerAvailable = false,
  installerAvailable = windowsInstallerAvailable,
  runtimePlatform = windowsInstallerAvailable ? "windows" : "unknown",
  runtimeInstallerAttempted = false,
  requiredRuntimeVersion = "",
  requiredRuntimeRevision = "",
} = {}) {
  const state = outcome?.state ?? "runtime_failed";
  const processState = outcome?.response?.runtime?.processState ?? null;
  const update = normalizedUpdate(outcome, requiredRuntimeVersion, requiredRuntimeRevision);

  if (state === "runtime_unchecked") {
    return view({
      badge: "Not checked",
      badgeState: "",
      summary: "Check AkuBrowser Runtime when you are ready.",
      detail: "No local runtime process will be contacted until you select Check runtime.",
      actionKind: RUNTIME_SETUP_ACTIONS.CHECK,
      actionLabel: "Check runtime",
    });
  }

  if (state === "runtime_ready") {
    if (outcome?.runtimeSource === "portable") {
      return view({
        badge: "Portable runtime running",
        badgeState: "ready",
        summary: "An unmanaged portable AkuBrowser Runtime is running.",
        detail: [
          outcome?.observedDetail,
          "Stop it manually from its terminal or extracted bundle before switching to the installed runtime.",
        ].filter(Boolean).join(" "),
        runtimeReady: true,
        executableLocation: runtimeExecutableLocation(outcome, runtimePlatform),
        executableLocationHint: "Open the folder where you extracted the portable AkuBrowser bundle.",
        actionKind: RUNTIME_SETUP_ACTIONS.CHECK,
        actionLabel: "Check after stopping",
      });
    }
    const updateView = runtimeUpdateView(outcome, update, installerAvailable, runtimePlatform, true);
    if (updateView) return updateView;
    return view({
      badge: "Running",
      badgeState: "ready",
      summary: "AkuBrowser Runtime is running.",
      detail: "The installed runtime is compatible and ready for AkuBrowser.",
      runtimeReady: true,
      executableLocation: runtimeExecutableLocation(outcome, runtimePlatform),
      executableLocationHint: runtimeExecutableLocationHint(runtimePlatform),
      actionKind: RUNTIME_SETUP_ACTIONS.STOP,
      actionLabel: "Stop runtime",
    });
  }

  if (state === "runtime_install_required") {
    return view({
      badge: "Not installed",
      badgeState: "warning",
      summary: "AkuBrowser Runtime is not installed.",
      detail: installerAvailable
        ? "Install the latest runtime on this device. Setup will detect it when you return."
        : "Install a compatible runtime using the platform release instructions.",
      actionKind: installerAvailable
        ? RUNTIME_SETUP_ACTIONS.INSTALL
        : RUNTIME_SETUP_ACTIONS.NONE,
      actionLabel: installerAvailable ? "Install runtime" : "Installer unavailable",
      actionDisabled: !installerAvailable,
      showInstallerNote: true,
      showSecurityNotice: runtimePlatform === "windows",
      showManualFallback: installerAvailable && runtimeInstallerAttempted,
    });
  }

  if (state === "runtime_incompatible") {
    const updateView = runtimeUpdateView(outcome, update, installerAvailable, runtimePlatform, false);
    if (updateView) return updateView;
    return runtimeConflictView();
  }

  if (state === "runtime_updating") {
    return view({
      badge: "Updating",
      badgeState: "warning",
      summary: "AkuBrowser Runtime is updating.",
      detail: "Keep Chrome open while the latest compatible runtime is prepared.",
      actionLabel: "Updating...",
      actionDisabled: true,
      showSecurityNotice: runtimePlatform === "windows",
    });
  }

  if (state === "runtime_busy") {
    return view({
      badge: "Busy",
      badgeState: "warning",
      summary: "AkuBrowser Runtime is busy.",
      detail: "Finish the active work before updating or restarting the runtime.",
      actionLabel: "Runtime busy",
      actionDisabled: true,
    });
  }

  if (state === "runtime_restart_required") {
    return view({
      badge: "Restart required",
      badgeState: "warning",
      summary: "Chrome needs to restart.",
      detail: "Close every Chrome window, then reopen Chrome to finish the runtime handoff.",
      actionLabel: "Restart Chrome",
      actionDisabled: true,
    });
  }

  if (state === "runtime_stopped" || processState === "stopped") {
    return view({
      badge: "Ready",
      badgeState: "ready",
      summary: "AkuBrowser Runtime is installed.",
      detail: "The compatible runtime is available locally but is not running.",
      actionKind: RUNTIME_SETUP_ACTIONS.ENSURE,
      actionLabel: "Run AkuBrowser",
    });
  }

  const repairWithInstaller = installerAvailable
    && outcome?.remediation === "reinstall_runtime";
  return view({
    badge: "Needs attention",
    badgeState: "warning",
    summary: repairWithInstaller
      ? "AkuBrowser Runtime needs repair."
      : "AkuBrowser Runtime could not start.",
    detail: repairWithInstaller
      ? "Run the latest installer again to repair the local runtime."
      : runtimePlatform === "windows"
      ? "Review the Windows security notice, then try again or use the manual bundle."
      : "Try again. If the problem continues, repair the companion runtime.",
    actionKind: repairWithInstaller
      ? RUNTIME_SETUP_ACTIONS.INSTALL
      : RUNTIME_SETUP_ACTIONS.ENSURE,
    actionLabel: repairWithInstaller ? "Repair runtime" : "Try again",
    retryAction: !repairWithInstaller,
    showInstallerNote: repairWithInstaller,
    showSecurityNotice: runtimePlatform === "windows",
    showManualFallback: installerAvailable,
  });
}

function view(overrides) {
  return {
    badge: "Needs attention",
    badgeState: "warning",
    summary: "AkuBrowser Runtime needs attention.",
    detail: "Review the runtime status and try again.",
    runtimeReady: false,
    actionKind: RUNTIME_SETUP_ACTIONS.NONE,
    actionLabel: "Unavailable",
    actionDisabled: false,
    retryAction: false,
    showInstallerNote: false,
    showSecurityNotice: false,
    showConflictNotice: false,
    showManualFallback: false,
    executableLocation: "",
    executableLocationHint: "",
    ...overrides,
  };
}

function runtimeConflictView(overrides = {}) {
  return view({
    badge: "Version conflict",
    badgeState: "warning",
    summary: "An older portable AkuBrowser Runtime is still running.",
    detail: "Stop it before AkuBrowser can start the installed runtime. Repeated checks will not resolve this conflict.",
    actionKind: RUNTIME_SETUP_ACTIONS.RESOLVE_CONFLICT,
    actionLabel: "Stop older runtime",
    showConflictNotice: true,
    ...overrides,
  });
}

function runtimeExecutableLocation(outcome, runtimePlatform) {
  if (outcome?.runtimeSource === "portable") {
    return runtimePlatform === "windows"
      ? "<extracted AkuBrowser folder>\\AkuSidecar.exe"
      : "<extracted AkuBrowser folder>/AkuSidecar";
  }
  const version = outcome?.response?.runtime?.version;
  if (runtimePlatform === "windows") {
    if (!version) return "%LOCALAPPDATA%\\Programs\\AkuBrowser\\runtime\\versions\\<version>\\AkuSidecar.exe";
    return `%LOCALAPPDATA%\\Programs\\AkuBrowser\\runtime\\versions\\${version}\\AkuSidecar.exe`;
  }
  if (runtimePlatform === "macos") {
    return `~/Library/Application Support/AkuBrowser/runtime/versions/${version || "<version>"}/AkuSidecar`;
  }
  return "";
}

function runtimeExecutableLocationHint(runtimePlatform) {
  return runtimePlatform === "macos"
    ? "Use Finder → Go → Go to Folder to open this location."
    : "Paste this path into File Explorer if you need to access it manually.";
}

function normalizedUpdate(outcome, requiredVersion, requiredRevision) {
  const reported = outcome?.response?.update ?? null;
  if (reported?.currentVersion && reported?.targetVersion) return reported;
  const runtime = outcome?.response?.runtime;
  const currentVersion = reported?.currentVersion ?? runtime?.version ?? null;
  const releaseMismatch = currentVersion && requiredVersion && currentVersion !== requiredVersion;
  const revisionMismatch = runtime?.runtimeRevision && requiredRevision
    && runtime.runtimeRevision !== requiredRevision;
  if (!currentVersion || (!releaseMismatch && !revisionMismatch)) return reported;
  return {
    ...reported,
    currentVersion,
    targetVersion: requiredVersion || currentVersion,
  };
}

function runtimeUpdateView(outcome, update, installerAvailable, runtimePlatform, runtimeReady) {
  const versionDetail = versionTransition(update);
  if (!versionDetail) return null;
  const sameVersionRepair = update.currentVersion === update.targetVersion;
  const stableChannel = outcome?.response?.runtime?.channel === "stable";
  const installerAction = installerAvailable && (!stableChannel || sameVersionRepair);
  return view({
    badge: sameVersionRepair ? "Repair required" : "Update available",
    badgeState: "warning",
    summary: sameVersionRepair
      ? "AkuBrowser Runtime needs a matching build."
      : "AkuBrowser Runtime has an update available.",
    detail: runtimeReady
      ? `${versionDetail} The current runtime remains usable until you update it.`
      : `${versionDetail} Update the installed runtime before starting AkuBrowser.`,
    runtimeReady,
    executableLocation: runtimeReady
      ? runtimeExecutableLocation(outcome, runtimePlatform)
      : "",
    executableLocationHint: runtimeReady
      ? runtimeExecutableLocationHint(runtimePlatform)
      : "",
    actionKind: installerAction
      ? RUNTIME_SETUP_ACTIONS.INSTALL
      : RUNTIME_SETUP_ACTIONS.ENSURE,
    actionLabel: sameVersionRepair ? "Repair runtime" : "Update runtime",
    showInstallerNote: installerAction,
    showSecurityNotice: runtimePlatform === "windows",
  });
}

function versionTransition(update) {
  if (!update?.currentVersion || !update?.targetVersion) return "";
  if (update.currentVersion === update.targetVersion) {
    return `Version ${update.currentVersion} is installed, but its runtime build does not match this extension.`;
  }
  return `Version ${update.currentVersion} is installed; version ${update.targetVersion} is required.`;
}
