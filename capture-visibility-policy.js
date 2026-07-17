const POLICIES = new Set(["quiet", "adaptive_fidelity"]);

export function normalizeCaptureVisibilityPolicy(value) {
  return POLICIES.has(value) ? value : "quiet";
}

export function planCaptureVisibility({ policy, mode, foregroundAuthorized = false }) {
  const normalizedPolicy = normalizeCaptureVisibilityPolicy(policy);
  if (mode === "recapture_media") {
    return {
      policy: normalizedPolicy,
      initialMode: "managed_window",
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
    allowSameWindowFallback: false,
  };
}
