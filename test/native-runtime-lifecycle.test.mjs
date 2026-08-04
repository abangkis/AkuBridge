import test from "node:test";
import assert from "node:assert/strict";
import { planNativeRuntimeLifecycle } from "../native-runtime-lifecycle.js";

test("first Store install opens setup without contacting the native host", () => {
  assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason: "install" }), {
    action: "none",
    trigger: "installed_install",
    openSetup: true,
  });
});

test("Chrome and PC restart reconcile a stopped or crashed runtime", () => {
  assert.deepEqual(planNativeRuntimeLifecycle("startup"), {
    action: "ensure_runtime",
    trigger: "startup",
    openSetup: false,
  });
});

test("every Chrome extension update reason reconciles the compatible tuple", () => {
  for (const reason of ["update", "chrome_update", "shared_module_update"]) {
    assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason }), {
      action: "ensure_runtime",
      trigger: `installed_${reason}`,
      openSetup: false,
    });
  }
});

test("unknown lifecycle events and installation reasons fail closed", () => {
  assert.throws(
    () => planNativeRuntimeLifecycle("installed", { reason: "unknown" }),
    /Unsupported Chrome installation reason/,
  );
  assert.throws(
    () => planNativeRuntimeLifecycle("arbitrary_event"),
    /Unsupported native runtime lifecycle event/,
  );
});
