export const CODEX_SETUP_ACTIONS = Object.freeze({
  NONE: "none",
  CHECK: "check",
});

export function codexSetupView(outcome = { state: "codex_unchecked" }) {
  switch (outcome?.state) {
  case "codex_checking":
    return view({
      badge: "Checking",
      detail: "Checking for a compatible local Codex App Server installation. The probe is bounded and does not read your credentials.",
      actionLabel: "Checking...",
      actionDisabled: true,
    });
  case "codex_available":
    return view({
      available: true,
      badge: "Installed",
      badgeState: "ready",
      detail: "A compatible Codex installation was detected. Confirm that you are signed in and all prerequisites are ready.",
      actionLabel: "Installed",
      actionDisabled: true,
      showConfirmation: true,
      showDetectedDetail: true,
    });
  case "codex_not_found":
    return view({
      badge: "Not installed",
      badgeState: "warning",
      detail: "A compatible Codex App Server installation was not found. Complete the steps below, then try again.",
      actionKind: CODEX_SETUP_ACTIONS.CHECK,
      actionLabel: "Try again",
      showDownload: true,
      showInstructions: true,
    });
  case "codex_check_failed":
    return view({
      badge: "Check failed",
      badgeState: "warning",
      detail: "The Codex check could not finish through the local runtime. Make sure AkuBrowser Runtime is still running, then try again.",
      actionKind: CODEX_SETUP_ACTIONS.CHECK,
      actionLabel: "Try again",
    });
  case "codex_runtime_required":
    return view({
      badge: "Runtime required",
      badgeState: "warning",
      detail: "Install AkuBrowser Runtime first so its registered host can check Codex safely.",
      actionKind: CODEX_SETUP_ACTIONS.CHECK,
      actionLabel: "Try again",
    });
  default:
    return view({
      badge: "Not checked",
      detail: "No Codex check runs automatically. Select Check Codex when you are ready.",
      actionKind: CODEX_SETUP_ACTIONS.CHECK,
      actionLabel: "Check Codex",
    });
  }
}

function view(overrides) {
  return {
    available: false,
    badge: "Not checked",
    badgeState: "",
    detail: "",
    actionKind: CODEX_SETUP_ACTIONS.NONE,
    actionLabel: "Check Codex",
    actionDisabled: false,
    showDownload: false,
    showInstructions: false,
    showConfirmation: false,
    showDetectedDetail: false,
    ...overrides,
  };
}
