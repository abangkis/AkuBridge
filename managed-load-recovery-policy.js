export const MANAGED_LOAD_RECOVERY_RECREATE_ONCE = "recreate_managed_once";
export const MANAGED_READINESS_RECOVERY_ADAPTER_DIRECTED = "adapter_directed";

export function shouldRecoverManagedSurface({
  error,
  attempt,
  opened,
  reset,
  policy,
}) {
  if (attempt !== 0) return false;
  const managedLoad = typeof policy === "string" ? policy : policy?.managedLoad;
  if (error?.code === "tab_load_timeout") {
    return (opened === true || reset === true) &&
      managedLoad === MANAGED_LOAD_RECOVERY_RECREATE_ONCE;
  }
  const recovery = error?.details?.readiness?.recoveryHint;
  return error?.code === "source_readiness_failed" &&
    policy?.managedReadiness === MANAGED_READINESS_RECOVERY_ADAPTER_DIRECTED &&
    recovery?.action === "recreate_managed_surface" &&
    recovery?.maxAttempts === 1;
}

export function shouldRecoverManagedLoad({
  source,
  error,
  attempt,
  opened,
  reset,
  policy,
}) {
  return source === "facebook" && shouldRecoverManagedSurface({
    error,
    attempt,
    opened,
    reset,
    policy,
  });
}

export function managedSurfaceReleaseAllowsRecreate(outcome) {
  if (outcome?.released === true) return true;
  return outcome?.reason === "surface_already_closed" ||
    outcome?.mode === "source_surface_already_closed";
}
