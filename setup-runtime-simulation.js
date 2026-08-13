export const RUNTIME_INSTALL_REQUIRED_SIMULATION = "not-installed";
export const RUNTIME_UPDATE_REQUIRED_SIMULATION = "update-required";
export const RUNTIME_STOPPED_SIMULATION = "stopped";
export const RUNTIME_RUNNING_SIMULATION = "running";
export const RUNTIME_VERSION_CONFLICT_SIMULATION = "version-conflict";

export function simulatedRuntimeOutcome(search = "") {
  const requestedState = new URLSearchParams(search).get("simulateRuntime");
  if (requestedState === RUNTIME_INSTALL_REQUIRED_SIMULATION) {
    return { state: "runtime_install_required" };
  }
  if (requestedState === RUNTIME_UPDATE_REQUIRED_SIMULATION) {
    return {
      state: "runtime_incompatible",
      response: {
        runtime: { processState: "stopped" },
        update: { currentVersion: "0.7.9", targetVersion: "0.8.0" },
      },
    };
  }
  if (requestedState === RUNTIME_STOPPED_SIMULATION) {
    return {
      state: "runtime_failed",
      errorCode: "runtime_start_failed",
      response: {
        runtime: { processState: "stopped" },
        update: { currentVersion: "0.8.0", targetVersion: "0.8.0" },
      },
    };
  }
  if (requestedState === RUNTIME_RUNNING_SIMULATION) {
    return {
      state: "runtime_ready",
      response: {
        runtime: { processState: "ready" },
        update: { currentVersion: "0.8.0", targetVersion: "0.8.0" },
      },
    };
  }
  if (requestedState === RUNTIME_VERSION_CONFLICT_SIMULATION) {
    return { state: "runtime_incompatible" };
  }
  return null;
}
