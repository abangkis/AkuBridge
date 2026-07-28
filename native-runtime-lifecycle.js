const INSTALLED_REASONS = new Set([
  "install",
  "update",
  "chrome_update",
  "shared_module_update",
]);

export function planNativeRuntimeLifecycle(event, details = {}) {
  if (event === "installed") {
    const reason = String(details.reason ?? "");
    if (!INSTALLED_REASONS.has(reason)) {
      throw new TypeError(`Unsupported Chrome installation reason: ${reason || "missing"}`);
    }
    return Object.freeze({
      action: reason === "install" ? "status" : "ensure_runtime",
      trigger: `installed_${reason}`,
      openSetup: reason === "install",
    });
  }
  if (event === "startup") {
    return Object.freeze({
      action: "ensure_runtime",
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
