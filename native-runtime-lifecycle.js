const INSTALLED_REASONS = new Set([
  "install",
  "update",
  "chrome_update",
  "shared_module_update",
]);

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
    return Object.freeze({ action, trigger: `installed_${reason}` });
  }
  if (event === "startup") {
    return Object.freeze({
      action: distribution === "development" ? "none" : "reconcile_runtime",
      trigger: "startup",
    });
  }
  if (event === "action") {
    return Object.freeze({
      action: "ensure_runtime",
      trigger: "action",
    });
  }
  throw new TypeError(`Unsupported native runtime lifecycle event: ${String(event)}`);
}

export function nativeRuntimeDistribution(deployment = {}) {
  if (deployment.runtimeLifecycle === "managed") return "production";
  if (deployment.runtimeLifecycle === "manual") return "development";
  throw new TypeError(`Unsupported AkuBridge runtime lifecycle: ${String(deployment.runtimeLifecycle ?? "missing")}`);
}
