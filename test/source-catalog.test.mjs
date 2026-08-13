import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceDefinition,
  sourceDefinitions,
  sourceHydrationTimeout,
} from "../source-catalog.js";

test("every source exposes a hydration window of plus or minus five seconds", () => {
  for (const source of sourceDefinitions()) {
    assert.equal(source.hydration.minTimeoutMs, source.hydration.defaultTimeoutMs - 5_000);
    assert.equal(source.hydration.maxTimeoutMs, source.hydration.defaultTimeoutMs + 5_000);
  }
});

test("source hydration timeout is rounded to seconds and bounded by the catalog", () => {
  assert.equal(sourceHydrationTimeout("x"), 12_000);
  assert.equal(sourceHydrationTimeout("x", 7_400), 7_000);
  assert.equal(sourceHydrationTimeout("x", 50_000), 17_000);
  assert.equal(sourceHydrationTimeout("linkedin", 21_000), 21_000);
  assert.equal(sourceHydrationTimeout("facebook", 1_000), 20_000);
  assert.equal(sourceHydrationTimeout("instagram", 50_000), 20_000);
});

test("source recovery remains capability-scoped", () => {
  assert.equal(sourceDefinition("facebook").captureRecovery.emptyObservation, "reload_managed_once_if_unready");
  assert.deepEqual(sourceDefinition("x").captureRecovery, {
    managedLoad: "recreate_managed_once",
    managedReadiness: "adapter_directed",
  });
  assert.equal(sourceDefinition("linkedin").captureRecovery, undefined);
  assert.deepEqual(sourceDefinition("instagram").captureRecovery, {
    managedLoad: "recreate_managed_once",
    managedReadiness: "adapter_directed",
  });
  assert.deepEqual(sourceDefinition("instagram").captureReuse, {
    readyInactiveCanonicalTab: true,
  });
  assert.deepEqual(sourceDefinition("instagram").captureFallback, {
    emptyShell: "instagram_structured_feed_v1",
  });
  for (const source of ["x", "linkedin", "facebook"]) {
    assert.equal(sourceDefinition(source).captureReuse, undefined);
    assert.equal(sourceDefinition(source).captureFallback, undefined);
  }
  assert.equal(sourceDefinition("facebook").captureRecovery.managedReadiness, undefined);
});

test("early source-ready navigation is isolated to X and Instagram", () => {
  for (const source of ["x", "instagram"]) {
    assert.equal(
      sourceDefinition(source).navigation.readinessMode,
      "tab_complete_or_source_ready",
    );
  }
  for (const source of ["linkedin", "facebook"]) {
    assert.equal(sourceDefinition(source).navigation, undefined);
  }
});
