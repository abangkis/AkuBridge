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
} = {}) {
  const state = outcome?.state ?? "runtime_failed";
  const processState = outcome?.response?.runtime?.processState ?? null;
  const update = outcome?.response?.update ?? null;

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
    return view({
      badge: "Running",
      badgeState: "ready",
      summary: "AkuBrowser Runtime is running.",
      detail: "The installed runtime is compatible and ready for AkuBrowser.",
      runtimeReady: true,
      executableLocation: runtimeExecutableLocation(outcome, windowsInstallerAvailable),
      executableLocationHint: outcome?.runtimeSource === "portable"
        ? "Open the folder where you extracted the portable AkuBrowser bundle."
        : "Paste this path into File Explorer if you need to access it manually.",
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
    const versionDetail = versionTransition(update);
    const updateAvailable = Boolean(versionDetail);
    return view({
      badge: updateAvailable ? "Update available" : "Version conflict",
      badgeState: "warning",
      summary: updateAvailable
        ? "AkuBrowser Runtime needs an update."
        : "Another AkuBrowser Runtime is conflicting with this installation.",
      detail: updateAvailable
        ? `${versionDetail} Update the installed runtime before starting AkuBrowser.`
        : "Stop the older portable runtime, then retry the installed runtime.",
      actionKind: RUNTIME_SETUP_ACTIONS.ENSURE,
      actionLabel: updateAvailable ? "Update runtime" : "Try again",
      retryAction: !updateAvailable,
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

function versionTransition(update) {
  if (!update?.currentVersion || !update?.targetVersion) return "";
  if (update.currentVersion === update.targetVersion) return "";
  return `Version ${update.currentVersion} is installed; version ${update.targetVersion} is required.`;
}
