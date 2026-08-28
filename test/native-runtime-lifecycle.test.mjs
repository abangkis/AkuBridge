import test from "node:test";
import assert from "node:assert/strict";
import {
  nativeRuntimeDistribution,
  planNativeRuntimeLifecycle,
} from "../native-runtime-lifecycle.js";

test("first install does not open legacy setup or contact the native host", () => {
  assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason: "install" }), {
    action: "none",
    trigger: "installed_install",
  });
});

test("install planning is independent of the removed setup page", () => {
  for (const mode of ["development", "production-app"]) {
    assert.deepEqual(planNativeRuntimeLifecycle("installed", {
      reason: "install",
      distribution: mode === "development" ? "development" : "production",
      mode,
    }), {
      action: "none",
      trigger: "installed_install",
    });
  }
  assert.deepEqual(planNativeRuntimeLifecycle("installed", {
    reason: "install",
    distribution: "production",
    mode: "production-store",
  }), {
    action: "none",
    trigger: "installed_install",
  });
});

test("Chrome and PC restart reconcile a stopped or crashed runtime", () => {
  assert.deepEqual(planNativeRuntimeLifecycle("startup", { distribution: "production" }), {
    action: "reconcile_runtime",
    trigger: "startup",
  });
});

test("an AkuBridge package update checks the signed Sidecar feed immediately", () => {
  assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason: "update", distribution: "production" }), {
    action: "ensure_runtime",
    trigger: "installed_update",
  });
});

test("Chrome and shared-module updates only reconcile the compatible runtime", () => {
  for (const reason of ["chrome_update", "shared_module_update"]) {
    assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason, distribution: "production" }), {
      action: "reconcile_runtime",
      trigger: `installed_${reason}`,
    });
  }
});

test("unpacked development reload and Chrome startup never start the installed runtime", () => {
  for (const reason of ["install", "update", "chrome_update", "shared_module_update"]) {
    assert.deepEqual(planNativeRuntimeLifecycle("installed", { reason, distribution: "development" }), {
      action: "none",
      trigger: `installed_${reason}`,
    });
  }
  assert.deepEqual(planNativeRuntimeLifecycle("startup", { distribution: "development" }), {
    action: "none",
    trigger: "startup",
  });
});

test("trusted deployment metadata selects manual or managed runtime lifecycle", () => {
  assert.equal(nativeRuntimeDistribution({ runtimeLifecycle: "manual" }), "development");
  assert.equal(nativeRuntimeDistribution({ runtimeLifecycle: "managed" }), "production");
  assert.throws(() => nativeRuntimeDistribution({}), /runtime lifecycle/);
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
  assert.throws(
    () => planNativeRuntimeLifecycle("startup", { distribution: "unknown" }),
    /Unsupported AkuBridge distribution/,
  );
});
