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

test("empty observation recovery is explicit and does not alter established adapters", () => {
  assert.equal(sourceDefinition("facebook").captureRecovery.emptyObservation, "reload_managed_once_if_unready");
  assert.equal(sourceDefinition("x").captureRecovery, undefined);
  assert.equal(sourceDefinition("linkedin").captureRecovery, undefined);
  assert.equal(sourceDefinition("instagram").captureRecovery, undefined);
});
