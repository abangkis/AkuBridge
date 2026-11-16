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
  }
  const scripts = sourceRuntimeScripts();
  for (const file of DIAGNOSTIC_SCRIPTS) assert.equal(scripts.filter(entry => entry === file).length, 1);
});
