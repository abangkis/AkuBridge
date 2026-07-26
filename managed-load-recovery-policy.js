export const MANAGED_LOAD_RECOVERY_RECREATE_ONCE = "recreate_managed_once";

export function shouldRecoverManagedLoad({
  source,
  error,
  attempt,
  opened,
  reset,
  policy,
}) {
  return source === "facebook" &&
    error?.code === "tab_load_timeout" &&
    attempt === 0 &&
    (opened === true || reset === true) &&
    policy === MANAGED_LOAD_RECOVERY_RECREATE_ONCE;
}

export function managedSurfaceReleaseAllowsRecreate(outcome) {
  if (outcome?.released === true) return true;
  return outcome?.reason === "surface_already_closed" ||
    outcome?.mode === "source_surface_already_closed";
}
