const INSTALLED_REASONS = new Set([
  "install",
  "update",
  "chrome_update",
  "shared_module_update",
]);
const LEGACY_SETUP_MODES = new Set(["production-store", "acceptance"]);

export function planNativeRuntimeLifecycle(event, details = {}) {
  const distribution = details.distribution ?? "production";
  if (distribution !== "development" && distribution !== "production") {
    throw new TypeError(`Unsupported AkuBridge distribution: ${String(distribution)}`);
  }
  if (event === "installed") {
    const reason = String(details.reason ?? "");
    if (!INSTALLED_REASONS.has(reason)) {
      throw new TypeError(`Unsupported Chrome installation reason: ${reason || "missing"}`);
    }
    const action = reason === "install" || distribution === "development"
      ? "none"
      : reason === "update"
        ? "ensure_runtime"
        : "reconcile_runtime";
    return Object.freeze({
      action,
      trigger: `installed_${reason}`,
      // The Store and pre-Store acceptance lanes still own their historical
      // options-page onboarding. Development and the isolated installed-app
      // lane have a Sidecar-owned setup surface, so they must never open the
      // legacy Bridge page as an install side effect.
      openSetup: reason === "install" && LEGACY_SETUP_MODES.has(String(details.mode ?? "production-store")),
    });
  }
  if (event === "startup") {
    return Object.freeze({
      action: distribution === "development" ? "none" : "reconcile_runtime",
      trigger: "startup",
      openSetup: false,
    });
  }
  if (event === "action") {
    return Object.freeze({
      action: "ensure_runtime",
      trigger: "action",
      openSetup: false,
    });
  }
  throw new TypeError(`Unsupported native runtime lifecycle event: ${String(event)}`);
}

export function nativeRuntimeDistribution(deployment = {}) {
  if (deployment.runtimeLifecycle === "managed") return "production";
  if (deployment.runtimeLifecycle === "manual") return "development";
  throw new TypeError(`Unsupported AkuBridge runtime lifecycle: ${String(deployment.runtimeLifecycle ?? "missing")}`);
}
