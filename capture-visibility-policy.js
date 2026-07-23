const DEFAULT_POLICY = "quiet";
const POLICIES = new Set([DEFAULT_POLICY, "quiet_multi_window", "adaptive_fidelity"]);

export function normalizeCaptureVisibilityPolicy(value) {
  return POLICIES.has(value) ? value : DEFAULT_POLICY;
}

export function planCaptureVisibility({ policy, mode, foregroundAuthorized = false }) {
  const normalizedPolicy = normalizeCaptureVisibilityPolicy(policy);
  const windowIsolation = normalizedPolicy === "quiet_multi_window"
    ? "per_source"
    : "shared";
  if (mode === "recapture_media") {
    return {
      policy: normalizedPolicy,
      initialMode: "managed_window",
      windowIsolation,
      allowSameWindowFallback: false,
      foregroundAuthorized: foregroundAuthorized === true,
    };
  }
  if (mode !== "catch_up") {
    return {
      policy: normalizedPolicy,
      initialMode: "same_window",
      allowSameWindowFallback: true,
    };
  }
  if (normalizedPolicy === "adaptive_fidelity") {
    return {
      policy: normalizedPolicy,
      initialMode: "same_window",
      allowSameWindowFallback: false,
    };
  }
  return {
    policy: normalizedPolicy,
    initialMode: "managed_window",
    windowIsolation,
    allowSameWindowFallback: false,
  };
}
