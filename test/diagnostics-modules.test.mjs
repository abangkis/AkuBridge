import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { registeredScriptsForSources, DIAGNOSTIC_SCRIPTS } from "../source-access-policy.js";
import { sourceRuntimeScripts } from "../source-catalog.js";

function runtime() {
  const realm = vm.createContext({});
  for (const file of DIAGNOSTIC_SCRIPTS) vm.runInContext(readFileSync(new URL("../" + file, import.meta.url), "utf8"), realm);
  return realm;
}
const plain = value => JSON.parse(JSON.stringify(value));

test("shared state is idempotent and needs no host services", () => {
  const forbidden = () => { throw Error("Host service used by shared state"); };
  const realm = vm.createContext({ Date: forbidden, performance: { now: forbidden },
    document: new Proxy({}, { get: forbidden }), fetch: forbidden, chrome: new Proxy({}, { get: forbidden }) });
  const source = readFileSync(new URL("../diagnostics/state-core.js", import.meta.url), "utf8");
  vm.runInContext(source, realm);
  const original = realm.AkuDiagnosticState;
  vm.runInContext(source, realm);
  assert.equal(realm.AkuDiagnosticState, original);
  const state = original.create();
  state.advance("body_read"); state.fail("body_read", "body_encoding"); state.fail("cleanup", "cleanup_failed");
  state.cleanup("uncertain", "stream_close_failed"); state.delivery("failed", "receiver_unavailable"); state.incomplete();
  const snapshot = state.snapshot(); snapshot.cause.condition = "changed"; snapshot.cleanup.state = "changed";
  assert.equal(state.snapshot().cause.condition, "body_encoding");
  assert.equal(state.snapshot().cleanup.state, "uncertain");
  assert.equal(state.snapshot().delivery.condition, "receiver_unavailable");
  assert.equal(state.snapshot().complete, false);
});

test("Bridge keeps validation and read-only snapshot sequence in its adapter", () => {
  const core = runtime().AkuDiagnosticRecorder;
  assert.throws(() => core.create("INVALID"), /Invalid diagnostic operation/);
  const recorder = core.create("capture");
  assert.throws(() => recorder.advance("INVALID"), /Invalid diagnostic phase/);
  assert.throws(() => recorder.fail("body_read", "INVALID"), /Invalid diagnostic cause/);
  assert.throws(() => recorder.cleanup("INVALID"), /Invalid diagnostic settlement/);
  recorder.advance("body_read", { known: true, value: 0 });
  recorder.completed("INVALID"); recorder.disposition("INVALID");
  assert.equal(recorder.snapshot().sequence, 1);
  assert.equal(recorder.snapshot().sequence, 1);
  assert.equal(recorder.snapshot().completed, "none");
  assert.equal(recorder.snapshot().disposition, "not_started");
});

test("generic recorder preserves unknown, first failure and independent snapshot values", () => {
  const { AkuDiagnosticRecorder: core } = runtime();
  const recorder = core.create("capture");
  recorder.advance("readiness");
  assert.deepEqual(plain(recorder.snapshot().elapsed), { known: false });
  recorder.advance("capture", { known: true, value: 0 });
  recorder.fail("capture", "receiver_unavailable");
  recorder.cleanup("failed", "cleanup_pending");
  recorder.fail("cleanup", "cleanup_pending");
  recorder.delivery("failed", "transport_unavailable");
  const snapshot = recorder.snapshot();
  assert.deepEqual(plain(snapshot.elapsed), { known: true, value: 0 });
  assert.equal(snapshot.cause.location.phase, "capture");
  snapshot.location.phase = "changed";
  snapshot.cause.location.phase = "changed";
  snapshot.cleanup.state = "changed";
  assert.equal(recorder.snapshot().location.phase, "capture");
  assert.equal(recorder.snapshot().cause.location.phase, "capture");
  assert.equal(recorder.snapshot().cleanup.state, "failed");
});

test("capture progress retains the legacy wire format and fixed product fields", () => {
  const { AkuBridgeDiagnostics: bridge } = runtime();
  const at = "2026-11-16T00:00:00.000Z";
  const progress = bridge.createProgress({ runtimeRevision: "source-adapters-v128", adapterRuntimeRevision: "source-adapters-v1", clock: () => at });
  assert.deepEqual(plain(progress.update("extracting_block", { source: "instagram", containerIndex: 0 })), {
    runtimeRevision: "source-adapters-v128", adapterRuntimeRevision: "source-adapters-v1",
    stage: "extracting_block", source: "instagram", containerIndex: 0, updatedAt: at,
  });
  const trap = { stage: "capture_started", source: "x", token: "secret", url: "https://private.test/", snapshotIndex: -1 };
  Object.defineProperty(trap, "scrolls", { get() { throw Error("getter executed"); } });
  assert.deepEqual(plain(bridge.project(trap)), { stage: "capture_started", source: "x" });
  assert.equal(bridge.project({ stage: "raw private exception" }), null);
});

test("the same diagnostics files precede every content entry point and dynamic injection", () => {
  for (const source of ["x", "instagram", "linkedin", "facebook"]) {
    const scripts = registeredScriptsForSources([source]).find(entry => entry.js.includes("content-script.js")).js;
    for (const file of DIAGNOSTIC_SCRIPTS) assert.ok(scripts.indexOf(file) < scripts.indexOf("content-script.js"));
    assert.ok(scripts.indexOf("diagnostics/state-core.js") < scripts.indexOf("diagnostics/recorder.js"));
  }
  const scripts = sourceRuntimeScripts();
  for (const file of DIAGNOSTIC_SCRIPTS) assert.equal(scripts.filter(entry => entry === file).length, 1);
});
