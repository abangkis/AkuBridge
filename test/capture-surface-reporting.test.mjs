import test from "node:test";
import assert from "node:assert/strict";
import { createReporterFixture, createRetainedOperationFixture } from "./helpers/capture-surface-reporting-fixture.mjs";
import { captureSurfacePolicyIdentity } from "../capture-surface-policy.js";
import { focusPolicyEvidence } from "../capture-surface-telemetry.js";

const endpoint = "http://127.0.0.1:11122";
const timestamp = "2026-11-04T02:00:00.000Z";
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t, response = { ok: true }) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(timestamp) });
  const calls = [];
  let key = "first", sequence = 0;
  t.mock.method(globalThis.crypto, "randomUUID", () => `uuid-${++sequence}`);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    if (response instanceof Error) throw response;
    return response;
  });
  const reporter = createReporterFixture({
    bridgeHeaders: token => ({ "X-Aku-Bridge-Token": token, "X-Aku-Capture-Instance": key,
      "X-Aku-Bridge-Id": "aku-browser", "X-Aku-Bridge-Contract": "2.0", "Content-Type": "ignored" }),
    responseError: async (result, fallback) => {
      const payload = await result.json().catch(() => ({}));
      return payload.message || `${fallback} (${result.status})`;
    },
  });
  return { ...reporter, calls, changeKey: value => { key = value; } };
}

test("capture reporting ignores only its established invalid batch inputs", async t => {
  const f = fixture(t);
  for (const args of [
    [null, "token", "s", "r", "x", [{ event: "created" }]],
    [endpoint, null, "s", "r", "x", [{ event: "created" }]],
    [endpoint, "token", "", "r", "x", [{ event: "created" }]],
    [endpoint, "token", 1, "r", "x", [{ event: "created" }]],
    [endpoint, "token", "s", "r", "x", null],
    [endpoint, "token", "s", "r", "x", []],
    [endpoint, "token", "s", "r", "x", [null, {}, { event: 7 }]],
  ]) assert.equal(await f.postCaptureSurfaceEvents(...args), undefined);
  assert.equal(f.calls.length, 0);
});

test("capture reporting preserves payload order, fallbacks, detail and executing policy", async t => {
  const f = fixture(t), policy = await captureSurfacePolicyIdentity();
  const events = [
    { event: "rejected", source: "linkedin", outcome: "A".repeat(125), occurredAt: "original-time",
      detail: { cleanupDiagnostics: { phase: "admission", firstReason: "url_not_owned" }, captureSurfacePolicy: { fingerprint: "untrusted" } } },
    { event: "released", source: "unknown", detail: { outcome: "cleanup_pending", cleanupDiagnostics: { phase: "release" } } },
    { event: 1 },
  ];
  const before = structuredClone(events);
  await f.postCaptureSurfaceEvents(endpoint, "token", "session", 9, "instagram", events);
  assert.deepEqual(events, before);
  const call = f.calls[0];
  assert.equal(call.url, `${endpoint}/api/bridge/capture-surfaces/events`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.deepEqual(call.payload, { events: [
    { id: "capture_surface_uuid-1", sessionId: "session", runId: "", source: "linkedin", event: "rejected",
      outcome: "A".repeat(120), occurredAt: "original-time", detail: { ...events[0].detail, captureSurfacePolicy: policy } },
    { id: "capture_surface_uuid-2", sessionId: "session", runId: "", source: "instagram", event: "released",
      outcome: "cleanup_pending", occurredAt: timestamp, detail: { ...events[1].detail, captureSurfacePolicy: policy } },
  ] });
  f.changeKey("replacement");
  await f.postCaptureSurfaceEvents(endpoint, "next-token", "session", "run", "invalid", [{ event: "", source: "invalid" }]);
  assert.equal(f.calls[1].headers["X-Aku-Capture-Instance"], "replacement");
  assert.equal(f.calls[1].headers["X-Aku-Bridge-Token"], "next-token");
  assert.equal(f.calls[1].payload.events[0].source, null);
  assert.equal(f.calls[1].payload.events[0].runId, "run");
  assert.equal(f.calls[1].payload.events[0].event, "");
});

test("capture event construction preserves focus evidence merge order and input identity", t => {
  const f = fixture(t), nested = { pending: 1 };
  const detail = { outcome: "B".repeat(125), containmentApplied: true, focusedWriteAttempted: true, nested };
  const event = f.captureSurfaceEvent("release_requested", "x", detail);
  assert.deepEqual(plain(event), { event: "release_requested", source: "x", outcome: "B".repeat(120),
    occurredAt: timestamp, detail: { ...focusPolicyEvidence(), ...detail } });
  assert.notEqual(event.detail, detail);
  assert.equal(event.detail.nested, nested);
  assert.equal(f.captureSurfaceEvent("created", "foreign").source, null);
  assert.equal(f.captureSurfaceEvent("created", "x").outcome, "");
});

test("capture reporting preserves the existing fallback ID recipe without a UUID API", async t => {
  const f = fixture(t), cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const subtle = globalThis.crypto.subtle;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle } });
  t.after(() => Object.defineProperty(globalThis, "crypto", cryptoDescriptor));
  t.mock.method(Math, "random", () => 0.5);
  // Construct after installing the isolated global capability, as in a browser realm.
  const reporter = createReporterFixture({ bridgeHeaders: () => ({}), responseError: async () => "unused" });
  await reporter.postCaptureSurfaceEvents(endpoint, "t", "s", "r", "x", [{ event: "created" }]);
  assert.equal(f.calls[0].payload.events[0].id, `capture_surface_${Date.parse(timestamp)}_${(0.5).toString(36).slice(2, 12)}`);
});

test("capture reporting retains server errors and malformed-body fallback", async t => {
  const f = fixture(t, { ok: false, status: 409, json: async () => ({ message: "original rejection" }) });
  await assert.rejects(f.postCaptureSurfaceEvents(endpoint, "t", "s", "r", "x", [{ event: "created" }]), { message: "original rejection" });
  assert.equal(f.calls.length, 1);
});

test("capture reporting preserves JSON fallback and network exception identity", async t => {
  const f = fixture(t, { ok: false, status: 503, json: async () => { throw Error("not JSON"); } });
  await assert.rejects(f.postCaptureSurfaceEvents(endpoint, "t", "s", "r", "x", [{ event: "created" }]), { message: "Could not record capture-surface telemetry (503)" });
});

test("capture reporting does not retry or replace a network failure", async t => {
  const marker = new Error("transport failure"), f = fixture(t, marker);
  await assert.rejects(f.postCaptureSurfaceEvents(endpoint, "t", "s", "r", "x", [{ event: "created" }]), error => error === marker);
  assert.equal(f.calls.length, 1);
});

test("dispatch retains observation-before-reporting-before-finish and ignores telemetry failure", async t => {
  const f = fixture(t, new Error("telemetry unavailable")), order = [];
  const command = { id: "command", type: "collect_visible", payload: { browserAdapter: "aku-bridge", captureLeaseId: "lease", source: "x" } };
  const operation = createRetainedOperationFixture({
    assertEndpoint: () => order.push("endpoint"), claimCommand: async () => { order.push("claim"); return command; },
    commandGuard: { begin: () => { order.push("begin"); return true; }, finish: () => order.push("finish") },
    rememberBackgroundLease: async () => order.push("lease"),
    captureWithSourceTabRecovery: async () => { order.push("capture"); return { coverage: { captureSurfaceLifecycle: [{ event: "created" }] } }; },
    postBridgeResult: async (_e, _t, _c, kind) => order.push(kind),
    postCaptureSurfaceEvents: async (...args) => { order.push("report"); return f.postCaptureSurfaceEvents(...args); },
  });
  await operation.dispatchRun({ endpoint, token: "token", runId: "run" });
  assert.deepEqual(order, ["endpoint", "claim", "begin", "lease", "capture", "observation", "report", "finish"]);
  assert.equal(f.calls.length, 1);
});

test("dispatch preserves original failure after reporting and failure submission both fail", async t => {
  const f = fixture(t, new Error("telemetry unavailable")), order = [], marker = new Error("capture rejected");
  marker.captureSurfaceLifecycle = [{ event: "rejected", detail: { cleanupDiagnostics: { phase: "admission" } } }];
  const operation = createRetainedOperationFixture({
    assertEndpoint: () => {}, claimCommand: async () => ({ id: "c", type: "collect_visible", payload: { browserAdapter: "aku-bridge", source: "x", captureLeaseId: "s" } }),
    commandGuard: { begin: () => true, finish: () => order.push("finish") }, rememberBackgroundLease: async () => {},
    captureWithSourceTabRecovery: async () => { throw marker; },
    postCaptureSurfaceEvents: async (...args) => { order.push("report"); return f.postCaptureSurfaceEvents(...args); },
    serializeBridgeError: error => { assert.equal(error, marker); return { message: error.message }; },
    postBridgeResult: async (_e, _t, _c, kind) => { order.push(kind); throw Error("submission failed"); },
  });
  await assert.rejects(operation.dispatchRun({ endpoint, token: "t", runId: "r" }), error => error === marker);
  assert.deepEqual(order, ["report", "failure", "finish"]);
  assert.equal(f.calls[0].payload.events[0].detail.cleanupDiagnostics.phase, "admission");
});

function releaseFixture(f, order, release) {
  return createRetainedOperationFixture({
    chrome: { storage: { local: { get: async () => ({ akuBridgeBackgroundDispatch: { endpoint, token: "token" } }) } } },
    managedCaptureWindow: { releaseSource: async (source, lease) => { order.push("release"); return release(source, lease); } },
    captureSurfaceEvent: f.captureSurfaceEvent,
    postCaptureSurfaceEvents: async (...args) => { order.push("report"); return f.postCaptureSurfaceEvents(...args); },
  });
}

test("surface release awaits request reporting then preserves the exact cleanup receipt", async t => {
  const f = fixture(t), order = [], outcome = { cleanup: { schema: "aku.surface-cleanup.v1", complete: true }, events: [{ event: "released" }] };
  const operation = releaseFixture(f, order, (source, lease) => { assert.equal(source, "x"); assert.equal(lease, "s"); return outcome; });
  assert.equal(await operation.releaseCaptureSurfaceWithTelemetry({ leaseId: "s", source: "x" }), outcome);
  assert.deepEqual(order, ["report", "release", "report"]);
  assert.equal(f.calls[0].payload.events[0].event, "release_requested");
  assert.equal(f.calls[1].payload.events[0].event, "released");
});

test("telemetry failure cannot prevent release or replace its outcome", async t => {
  const f = fixture(t, new Error("report failed")), order = [], outcome = { reason: "cleanup_pending" };
  const operation = releaseFixture(f, order, () => outcome);
  assert.equal(await operation.releaseCaptureSurfaceWithTelemetry({ leaseId: "s", source: "x" }), outcome);
  assert.deepEqual(order, ["report", "release", "report"]);
});

test("surface release failure stays authoritative and prevents result reporting", async t => {
  const f = fixture(t), order = [], marker = new Error("release failed");
  const operation = releaseFixture(f, order, () => { throw marker; });
  await assert.rejects(operation.releaseCaptureSurfaceWithTelemetry({ leaseId: "s", source: "x" }), error => error === marker);
  assert.deepEqual(order, ["report", "release"]);
  assert.equal(f.calls.length, 1);
});
