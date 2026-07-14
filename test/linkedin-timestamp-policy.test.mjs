import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadPolicy() {
  const context = vm.createContext({ Date });
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "linkedin-timestamp-policy.js"), "utf8"),
    context,
  );
  return context.AkuLinkedInTimestampPolicy;
}

test("LinkedIn relative hours become stable hour-precision estimates", () => {
  const policy = loadPolicy();
  assert.deepEqual(
    JSON.parse(JSON.stringify(policy.estimateFromRelativeText(
      "6h · Edited ·",
      "2026-07-14T00:37:48.321Z",
    ))),
    {
      publishedAt: "2026-07-13T18:00:00.000Z",
      amount: 6,
      unit: "h",
      precision: "hour",
      estimated: true,
    },
  );
  assert.equal(
    policy.estimateFromRelativeText("6h", "2026-07-14T00:59:59.999Z").publishedAt,
    "2026-07-13T18:00:00.000Z",
  );
});

test("LinkedIn day, week, month, and year estimates use deterministic UTC buckets", () => {
  const policy = loadPolicy();
  const capturedAt = "2026-07-14T15:37:48.321Z";
  assert.equal(policy.estimateFromRelativeText("1d", capturedAt).publishedAt, "2026-07-13T00:00:00.000Z");
  assert.equal(policy.estimateFromRelativeText("3w", capturedAt).publishedAt, "2026-06-22T00:00:00.000Z");
  assert.equal(policy.estimateFromRelativeText("1mo", capturedAt).publishedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(policy.estimateFromRelativeText("1yr", capturedAt).publishedAt, "2025-01-01T00:00:00.000Z");
});

test("LinkedIn timestamp estimation rejects connection degrees and unavailable labels", () => {
  const policy = loadPolicy();
  const capturedAt = "2026-07-14T15:37:48.321Z";
  assert.equal(policy.estimateFromRelativeText("2nd", capturedAt), null);
  assert.equal(policy.estimateFromRelativeText("Promoted", capturedAt), null);
  assert.equal(policy.estimateFromRelativeText("0h", capturedAt), null);
  assert.equal(policy.estimateFromRelativeText("1h30", capturedAt), null);
  assert.equal(policy.estimateFromRelativeText("6h", "not-a-date"), null);
});
