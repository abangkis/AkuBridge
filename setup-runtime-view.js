export const RUNTIME_SETUP_ACTIONS = Object.freeze({
  CHECK: "check",
  INSTALL: "install",
  ENSURE: "ensure",
  STOP: "stop",
  NONE: "none",
});
export const RUNTIME_CHECK_TIMEOUT_BASE_MS = 30_000;
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
        executableLocation: runtimeExecutableLocation(outcome, windowsInstallerAvailable),
        executableLocationHint: "Open the folder where you extracted the portable AkuBrowser bundle.",
        actionKind: RUNTIME_SETUP_ACTIONS.CHECK,
        actionLabel: "Check after stopping",
      });
    }
    const updateView = runtimeUpdateView(outcome, update, windowsInstallerAvailable, true);
    if (updateView) return updateView;
    return view({
      badge: "Running",
      badgeState: "ready",
      summary: "AkuBrowser Runtime is running.",
      detail: "The installed runtime is compatible and ready for AkuBrowser.",
      runtimeReady: true,
      executableLocation: runtimeExecutableLocation(outcome, windowsInstallerAvailable),
      executableLocationHint: "Paste this path into File Explorer if you need to access it manually.",
      actionKind: RUNTIME_SETUP_ACTIONS.STOP,
      actionLabel: "Stop runtime",
    });
  }

  if (state === "runtime_install_required") {
    return view({
      badge: "Not installed",
      badgeState: "warning",
      summary: "AkuBrowser Runtime is not installed.",
      detail: windowsInstallerAvailable
        ? "Install the latest runtime on this device. Setup will detect it when you return."
        : "Install a compatible runtime using the platform release instructions.",
      actionKind: windowsInstallerAvailable
        ? RUNTIME_SETUP_ACTIONS.INSTALL
        : RUNTIME_SETUP_ACTIONS.NONE,
      actionLabel: windowsInstallerAvailable ? "Install runtime" : "Installer unavailable",
      actionDisabled: !windowsInstallerAvailable,
      showInstallerNote: true,
      showSecurityNotice: windowsInstallerAvailable,
      showManualFallback: windowsInstallerAvailable && runtimeInstallerAttempted,
    });
  }

  if (state === "runtime_incompatible") {
    const updateView = runtimeUpdateView(outcome, update, windowsInstallerAvailable, false);
    if (updateView) return updateView;
    return view({
      badge: "Version conflict",
      badgeState: "warning",
      summary: "Another AkuBrowser Runtime is conflicting with this installation.",
      detail: "Stop the older portable runtime, then retry the installed runtime.",
      actionKind: RUNTIME_SETUP_ACTIONS.ENSURE,
      actionLabel: "Try again",
      retryAction: true,
      showSecurityNotice: windowsInstallerAvailable,
    });
  }

  if (state === "runtime_updating") {
    return view({
      badge: "Updating",
      badgeState: "warning",
      summary: "AkuBrowser Runtime is updating.",
      detail: "Keep Chrome open while the latest compatible runtime is prepared.",
      actionLabel: "Updating...",
      actionDisabled: true,
      showSecurityNotice: windowsInstallerAvailable,
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

  const repairWithInstaller = windowsInstallerAvailable
    && outcome?.remediation === "reinstall_runtime";
  return view({
    badge: "Needs attention",
    badgeState: "warning",
    summary: repairWithInstaller
      ? "AkuBrowser Runtime needs repair."
      : "AkuBrowser Runtime could not start.",
    detail: repairWithInstaller
      ? "Run the latest installer again to repair the local runtime."
      : windowsInstallerAvailable
      ? "Review the Windows security notice, then try again or use the manual bundle."
      : "Try again. If the problem continues, repair the companion runtime.",
    actionKind: repairWithInstaller
      ? RUNTIME_SETUP_ACTIONS.INSTALL
      : RUNTIME_SETUP_ACTIONS.ENSURE,
    actionLabel: repairWithInstaller ? "Repair runtime" : "Try again",
    retryAction: !repairWithInstaller,
    showInstallerNote: repairWithInstaller,
    showSecurityNotice: windowsInstallerAvailable,
    showManualFallback: windowsInstallerAvailable,
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
    showManualFallback: false,
    executableLocation: "",
    executableLocationHint: "",
    ...overrides,
  };
}

function runtimeExecutableLocation(outcome, windowsInstallerAvailable) {
  if (!windowsInstallerAvailable) return "";
  if (outcome?.runtimeSource === "portable") {
    return "<extracted AkuBrowser folder>\\AkuSidecar.exe";
  }
  const version = outcome?.response?.runtime?.version;
  if (!version) return "%LOCALAPPDATA%\\Programs\\AkuBrowser\\runtime\\versions\\<version>\\AkuSidecar.exe";
  return `%LOCALAPPDATA%\\Programs\\AkuBrowser\\runtime\\versions\\${version}\\AkuSidecar.exe`;
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

function runtimeUpdateView(outcome, update, windowsInstallerAvailable, runtimeReady) {
  const versionDetail = versionTransition(update);
  if (!versionDetail) return null;
  const sameVersionRepair = update.currentVersion === update.targetVersion;
  const stableChannel = outcome?.response?.runtime?.channel === "stable";
  const installerAction = windowsInstallerAvailable && (!stableChannel || sameVersionRepair);
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
      ? runtimeExecutableLocation(outcome, windowsInstallerAvailable)
      : "",
    executableLocationHint: runtimeReady
      ? "Paste this path into File Explorer if you need to access it manually."
      : "",
    actionKind: installerAction
      ? RUNTIME_SETUP_ACTIONS.INSTALL
      : RUNTIME_SETUP_ACTIONS.ENSURE,
    actionLabel: sameVersionRepair ? "Repair runtime" : "Update runtime",
    showInstallerNote: installerAction,
    showSecurityNotice: windowsInstallerAvailable,
  });
}

function versionTransition(update) {
  if (!update?.currentVersion || !update?.targetVersion) return "";
  if (update.currentVersion === update.targetVersion) {
    return `Version ${update.currentVersion} is installed, but its runtime build does not match this extension.`;
  }
  return `Version ${update.currentVersion} is installed; version ${update.targetVersion} is required.`;
}
