import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
  MANAGED_READINESS_RECOVERY_ADAPTER_DIRECTED,
  managedSurfaceReleaseAllowsRecreate,
  shouldRecoverManagedLoad,
  shouldRecoverManagedSurface,
} from "../managed-load-recovery-policy.js";

test("Facebook may recreate one Bridge-owned managed surface after a load timeout", () => {
  assert.equal(shouldRecoverManagedLoad({
    source: "facebook",
    error: { code: "tab_load_timeout" },
    attempt: 0,
    opened: true,
    reset: false,
    policy: MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
  }), true);
});

test("managed load recovery is bounded for every opted-in source", () => {
  for (const value of [
    { source: "facebook", error: { code: "tab_load_timeout" }, attempt: 1, opened: true, reset: false },
    { source: "facebook", error: { code: "tab_load_timeout" }, attempt: 0, opened: false, reset: false },
    { source: "facebook", error: { code: "selector_mismatch" }, attempt: 0, opened: true, reset: false },
  ]) {
    assert.equal(shouldRecoverManagedLoad({
      ...value,
      policy: MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
    }), false);
  }
  assert.equal(shouldRecoverManagedLoad({
    source: "linkedin",
    error: { code: "tab_load_timeout" },
    attempt: 0,
    opened: true,
    reset: false,
    policy: MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
  }), true);
});

test("managed surface recreation requires a confirmed safe cleanup outcome", () => {
  assert.equal(managedSurfaceReleaseAllowsRecreate({ released: true }), true);
  assert.equal(managedSurfaceReleaseAllowsRecreate({
    released: false,
    reason: "surface_already_closed",
  }), true);
  assert.equal(managedSurfaceReleaseAllowsRecreate({
    released: false,
    mode: "source_surface_already_closed",
  }), true);
  assert.equal(managedSurfaceReleaseAllowsRecreate({
    released: false,
    reason: "lease_mismatch",
  }), false);
  assert.equal(managedSurfaceReleaseAllowsRecreate({
    released: false,
    reason: "no_owned_source_surface",
  }), false);
});

test("adapter-directed readiness recovery accepts only one bounded managed recreation", () => {
  const policy = {
    managedReadiness: MANAGED_READINESS_RECOVERY_ADAPTER_DIRECTED,
  };
  const error = {
    code: "source_readiness_failed",
    details: {
      readiness: {
        recoveryHint: {
          action: "recreate_managed_surface",
          reason: "feed_shell_unhydrated",
          maxAttempts: 1,
        },
      },
    },
  };
  assert.equal(shouldRecoverManagedSurface({
    error,
    attempt: 0,
    opened: false,
    reset: false,
    policy,
  }), true);
  assert.equal(shouldRecoverManagedSurface({
    error,
    attempt: 1,
    opened: false,
    reset: false,
    policy,
  }), false);
  assert.equal(shouldRecoverManagedSurface({
    error: {
      ...error,
      details: { readiness: { recoveryHint: { action: "reload_working_tab", maxAttempts: 1 } } },
    },
    attempt: 0,
    opened: false,
    reset: false,
    policy,
  }), false);
});
