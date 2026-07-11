import test from "node:test";
import assert from "node:assert/strict";
import {
  AkuBridgeError,
  classifyBridgeError,
  createCommandGuard,
  createTabLease,
  serializeBridgeError,
  validateTabLease,
} from "../bridge-runtime-policy.js";

test("tab leases retain source identity and tolerate same-source navigation", () => {
  const lease = createTabLease(
    { id: 12, windowId: 4, url: "https://x.com/home" },
    "x",
  );
  assert.equal(
    validateTabLease(lease, { id: 12, windowId: 4, url: "https://x.com/example/status/1" }).valid,
    true,
  );
  assert.deepEqual(
    validateTabLease(lease, { id: 12, windowId: 4, url: "https://example.com/" }),
    { valid: false, code: "wrong_page", reason: "source_url_changed" },
  );
});

test("tab leases fail closed when tab identity changes", () => {
  const lease = createTabLease(
    { id: 12, windowId: 4, url: "https://www.linkedin.com/feed/" },
    "linkedin",
  );
  assert.equal(validateTabLease(lease, null).code, "tab_stale");
  assert.equal(
    validateTabLease(lease, { id: 13, windowId: 4, url: "https://www.linkedin.com/feed/" }).code,
    "tab_replaced",
  );
});

test("command guard permits one terminal result per runtime generation", () => {
  const guard = createCommandGuard();
  assert.equal(guard.begin("command-1"), true);
  assert.equal(guard.begin("command-1"), false);
  guard.finish("command-1");
  assert.equal(guard.isTerminal("command-1"), true);
  assert.equal(guard.begin("command-1"), false);
  assert.equal(guard.begin("command-2"), true);
  guard.abandon("command-2");
  assert.equal(guard.begin("command-2"), true);
});

test("bridge failures are serialized with stable codes and stages", () => {
  const explicit = serializeBridgeError(
    new AkuBridgeError("selector_mismatch", "readiness", "LinkedIn selector mismatch."),
  );
  assert.equal(explicit.code, "selector_mismatch");
  assert.equal(explicit.stage, "readiness");
  assert.equal(classifyBridgeError(new Error("No tab with id: 99")), "tab_stale");
  assert.equal(classifyBridgeError(new Error("capture deadline exceeded")), "deadline_exceeded");
  assert.equal(classifyBridgeError(new Error("unexpected")), "bridge_failure");
});
