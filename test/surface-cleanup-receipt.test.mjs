import test from "node:test";
import assert from "node:assert/strict";
import { isVerifiedSurfaceCleanupReceipt } from "../surface-cleanup-receipt.js";

function outcome(overrides = {}, receiptOverrides = {}) {
  return {
    released: true,
    ...overrides,
    cleanup: {
      schema: "aku.surface-cleanup.v1",
      leaseId: "lease-1",
      source: null,
      expected: 2,
      closed: 1,
      transferred: 1,
      retained: 0,
      pending: 0,
      complete: true,
      ...receiptOverrides,
    },
  };
}

test("accepts strict complete receipts correlated to the requested lease and source", () => {
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome(), "lease-1", null), true);
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({}, { source: "x", retained: 1, expected: 1, closed: 0, transferred: 0 }), "lease-1", "x"), true);
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason: "no_owned_surface" }, { expected: 0, closed: 0, transferred: 0 }), "lease-1", null), true);
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason: "no_owned_surface" }), "lease-1", null), true);
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason: "no_owned_source_surface" }, { source: "x", expected: 0, closed: 0, transferred: 0 }), "lease-1", "x"), true);
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason: "surface_already_closed" }), "lease-1", null), true);
});

test("rejects absent, legacy, pending, malformed, or cross-lease receipts", () => {
  for (const candidate of [null, {}, { reason: "no_owned_surface", released: false }]) {
    assert.equal(isVerifiedSurfaceCleanupReceipt(candidate, "lease-1", null), false);
  }
  for (const overrides of [
    { schema: "legacy" },
    { leaseId: "lease-2" },
    { source: "x" },
    { complete: false },
    { pending: 1, expected: 3 },
    { expected: 3 },
    { retained: -1, expected: 1 },
    { closed: 1.5, expected: 3 },
    { closed: Number.MAX_SAFE_INTEGER + 1, expected: Number.MAX_SAFE_INTEGER + 1 },
    { expected: 4097, closed: 4097, transferred: 0 },
  ]) {
    assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({}, overrides), "lease-1", null), false);
  }
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome(), "lease-2", null), false);
  for (const reason of ["lease_mismatch", "cleanup_pending", "unknown_reason", null]) {
    assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason }, { expected: 0, closed: 0, transferred: 0 }), "lease-1", null), false);
  }
  assert.equal(isVerifiedSurfaceCleanupReceipt(outcome({ reason: "no_owned_source_surface" }, { expected: 0, closed: 0, transferred: 0 }), "lease-1", null), false);
});

test("terminal release and no-owned outcomes cannot claim retained records", () => {
  const retained = outcome({}, { expected: 1, retained: 1, closed: 0, transferred: 0 });
  assert.equal(isVerifiedSurfaceCleanupReceipt(retained, "lease-1", null), false);
  assert.equal(isVerifiedSurfaceCleanupReceipt({ ...retained, reason: "no_owned_surface" }, "lease-1", "x"), false);
});
