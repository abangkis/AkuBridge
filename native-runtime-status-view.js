const QUIET_PHASES = new Set(["idle", "complete", "rolled_back"]);

export function nativeRuntimeStatusView(state) {
  if (!state || typeof state !== "object") return null;
  const phase = state.update?.phase;
  if (state.hostUpgradeRequired === true) {
    return status(
      "mandatory",
      "AkuSidecar updater needs refresh",
      state.state === "runtime_ready"
        ? "Open AkuBrowser's local app shell; it will guide you through the compatible installer. Your current runtime remains usable."
        : "Open AkuBrowser's local app shell; it will guide you through the compatible installer to refresh the update helper.",
    );
  }
  if (state.errorCode && state.silentError !== true) {
    return status(
      "error",
      "AkuSidecar update needs attention",
      state.retryable ? "It will retry automatically." : "Open AkuBrowser's local app shell for recovery options.",
    );
  }
  if (["required", "security"].includes(state.update?.urgency)) {
    const deadline = formatDeadline(state.update?.deadline);
    return status(
      "mandatory",
      state.update.urgency === "security" ? "Security update required" : "AkuSidecar update required",
      deadline
        ? `It will be applied when idle. Required by ${deadline}.`
        : "It will be applied when current work is idle.",
    );
  }
  if (state.silentError === true) return null;

  if (state.state === "runtime_install_required") {
    return status("mandatory", "AkuSidecar is required", "Install AkuBrowser, then open its local app shell to continue.");
  }
  if (state.state === "runtime_incompatible") {
    return status("mandatory", "AkuSidecar update required", "Open AkuBrowser's local app shell to restore compatibility.");
  }
  if (state.state === "runtime_restart_required") {
    return status("mandatory", "Restart required", "Restart Chrome to finish the AkuSidecar update.");
  }
  if (state.state === "runtime_failed") {
    return status(
      "error",
      "AkuSidecar update needs attention",
      state.retryable ? "It will retry automatically." : "Open AkuBrowser's local app shell for recovery options.",
    );
  }
  if (state.state === "runtime_busy" || phase === "waiting_for_idle") {
    return status("waiting", "Update ready", "AkuSidecar will update when current work is idle.");
  }
  if (["staging", "staged"].includes(phase)) {
    return status("staged", "Update prepared", "AkuSidecar will apply it without interrupting active work.");
  }
  if (phase && !QUIET_PHASES.has(phase)) {
    return status("progress", "AkuSidecar is updating", "You can keep using compatible features.");
  }
  if (state.state === "runtime_updating") {
    return status("progress", "AkuSidecar is updating", "You can keep using compatible features.");
  }
  return null;
}

function formatDeadline(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function status(tone, title, detail) {
  return Object.freeze({ tone, title, detail });
}
