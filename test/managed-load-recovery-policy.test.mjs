import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
  managedSurfaceReleaseAllowsRecreate,
  shouldRecoverManagedLoad,
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

test("managed load recovery is bounded and Facebook-specific", () => {
  for (const value of [
    { source: "facebook", error: { code: "tab_load_timeout" }, attempt: 1, opened: true, reset: false },
    { source: "facebook", error: { code: "tab_load_timeout" }, attempt: 0, opened: false, reset: false },
    { source: "facebook", error: { code: "selector_mismatch" }, attempt: 0, opened: true, reset: false },
    { source: "linkedin", error: { code: "tab_load_timeout" }, attempt: 0, opened: true, reset: false },
  ]) {
    assert.equal(shouldRecoverManagedLoad({
      ...value,
      policy: MANAGED_LOAD_RECOVERY_RECREATE_ONCE,
    }), false);
  }
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
