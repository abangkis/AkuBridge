export const RUNTIME_INSTALL_REQUIRED_SIMULATION = "not-installed";

export function simulatedRuntimeOutcome(search = "") {
  const requestedState = new URLSearchParams(search).get("simulateRuntime");
  if (requestedState !== RUNTIME_INSTALL_REQUIRED_SIMULATION) return null;
  return { state: "runtime_install_required" };
}
