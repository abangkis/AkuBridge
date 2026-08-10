import test from "node:test";
import assert from "node:assert/strict";
import {
  captureWithParallelStructuredMedia,
  collectStructuredMediaWithinBudget,
} from "../structured-media-collection-runtime.js";

test("structured media collection records bounded completion telemetry", async () => {
  let current = 10;
  const result = await collectStructuredMediaWithinBudget({
    collector: async () => {
      current = 12.34;
      return { candidates: [{ candidateId: "facebook:post:123", media: [] }] };
    },
    tabId: 7,
    budgetMs: 250,
    now: () => current,
  });

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.diagnostics.collection, {
    runtimeRevision: "structured-media-collection-runtime-v1",
    mode: "parallel_deferred",
    status: "completed",
    budgetMs: 250,
    elapsedMs: 2.3,
  });
});

test("structured media collection times out failure-soft", async () => {
  let scheduled;
  const resultPromise = collectStructuredMediaWithinBudget({
    collector: () => new Promise(() => {}),
    budgetMs: 250,
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancel: () => {},
    now: () => 20,
  });
  scheduled();
  const result = await resultPromise;

  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.collection.status, "timeout");
  assert.equal(result.diagnostics.collection.budgetMs, 250);
});

test("capture starts without waiting for structured media collection", async () => {
  const events = [];
  let resolveCollection;
  const resultPromise = captureWithParallelStructuredMedia({
    capture: async () => {
      events.push("capture_started");
      return { ok: true };
    },
    collect: () => new Promise((resolve) => {
      events.push("collection_started");
      resolveCollection = resolve;
    }),
    deliver: async () => {
      events.push("evidence_delivered");
      return true;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events.slice(0, 2).sort(), ["capture_started", "collection_started"]);
  resolveCollection({ candidates: [] });
  const result = await resultPromise;

  assert.deepEqual(result, { response: { ok: true }, delivered: true });
  assert.equal(events.at(-1), "evidence_delivered");
});
