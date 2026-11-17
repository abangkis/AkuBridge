import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createReloadCoordinator } from "../reload-coordinator.js";

const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const start = worker.indexOf("async function collectFromTabWithDeadline(");
const end = worker.indexOf("\nasync function waitForTabComplete(", start);
assert.ok(start >= 0 && end > start);
const deadline = worker.slice(start, end);
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(diagnostics = () => new Promise(() => {}), coordinator = { run: operation => operation() }) {
  const capture = deferred(), timers = new Map(), requests = [];
  let now = 0, nextId = 0;
  const context = vm.createContext({
    crypto: { randomUUID },
    reloadCoordinator: coordinator,
    collectFromTab: (_tabId, payload) => { context.capturePayload = payload; return capture.promise; },
    chrome: { scripting: { executeScript: async () => [{ documentId: "doc-fixture" }] }, tabs: { sendMessage(tabId, message) {
      requests.push({ tabId, ...message });
      return Promise.resolve(diagnostics()).then(response => response ? {
        ...response, attemptId: message.attemptId, sequence: 1,
        diagnostics: { source: "instagram", ...response.diagnostics },
      } : response);
    } } },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  for (const file of ["state-core.js", "recorder.js", "bridge-contract.js", "chrome-transport.js"]) {
    vm.runInContext(readFileSync(new URL(`../diagnostics/${file}`, import.meta.url), "utf8"), context);
  }
  context.captureDiagnostics = context.AkuChromeDiagnostics.createAttemptCache({
    extensionId: "fixture", sourceForUrl: () => "instagram",
    project: context.AkuBridgeDiagnostics.project, validAttempt: context.AkuBridgeDiagnostics.validAttempt, now: () => now,
  });
  vm.runInContext(deadline, context);
  const result = { state: "pending" };
  context.collectFromTabWithDeadline(42, { captureTimeoutMs: 10_000, source: "instagram" }).then(
    value => Object.assign(result, { state: "fulfilled", value }),
    error => Object.assign(result, { state: "rejected", error }),
  );
  return {
    capture, requests, result, timers,
    push(stage, sequence = 1) {
      return context.captureDiagnostics.receive({ schemaVersion: 1, attemptId: context.capturePayload.diagnosticAttempt,
        sequence, progress: { stage, source: "instagram" } },
      { id: "fixture", tab: { id: 42 }, frameId: 0, documentId: "doc-fixture", url: "https://www.instagram.com/" });
    },
    async advance(milliseconds) {
      await flush();
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("silent capture and diagnostics still fail at the capture response deadline", async () => {
  const f = fixture();
  await f.advance(14_999);
  assert.equal(f.result.state, "pending");
  await f.advance(1);
  assert.equal(f.result.state, "rejected");
  assert.equal(f.result.error.message, "AkuBridge content capture exceeded its bounded response deadline.");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].tabId, 42);
  assert.equal(f.requests[0].type, "AKU_BROWSER_CAPTURE_DIAGNOSTICS");
  assert.equal(f.timers.size, 0);
});

test("available diagnostics retain the last content stage in timeout errors", async () => {
  const f = fixture(async () => ({ diagnostics: { stage: "extracting_block" } }));
  await f.advance(15_000);
  assert.equal(f.result.state, "rejected");
  assert.match(f.result.error.message, /Last content stage: \{"stage":"extracting_block","source":"instagram"\}\./);
});

test("failed or malformed diagnostics cannot prevent timeout", async t => {
  const circular = {}; circular.self = circular;
  for (const [name, diagnostics] of [
    ["rejected", () => Promise.reject(new Error("receiver unavailable"))],
    ["throws", () => { throw new Error("tab unavailable"); }],
    ["malformed", async () => ({ diagnostics: circular })],
  ]) await t.test(name, async () => {
    const f = fixture(diagnostics);
    await f.advance(15_000);
    assert.equal(f.result.state, "rejected");
    assert.equal(f.result.error.message, "AkuBridge content capture exceeded its bounded response deadline.");
    assert.equal(f.timers.size, 0);
  });
});

test("successful capture clears timers without requesting diagnostics", async () => {
  const f = fixture(), observation = { ok: true, observation: { source: "instagram" } };
  f.capture.resolve(observation);
  await flush();
  assert.equal(f.result.state, "fulfilled");
  assert.equal(f.result.value, observation);
  await f.advance(30_000);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test("capture can finish before deadline while diagnostics remain silent", async () => {
  const f = fixture();
  await f.advance(14_999);
  assert.equal(f.requests.length, 1);
  f.capture.resolve({ ok: true });
  await flush();
  await f.advance(1);
  assert.equal(f.result.state, "fulfilled");
  assert.equal(f.timers.size, 0);
});

test("capture rejection retains its original error and clears timers", async () => {
  const f = fixture(), original = new Error("content capture failed");
  f.capture.reject(original);
  await flush();
  assert.equal(f.result.error, original);
  await f.advance(30_000);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test("late capture or diagnostics cannot replace the deadline failure", async () => {
  const diagnostics = deferred(), f = fixture(() => diagnostics.promise);
  await f.advance(15_000);
  assert.equal(f.result.state, "rejected");
  const failure = f.result.error;
  diagnostics.resolve({ diagnostics: { stage: "late" } });
  f.capture.resolve({ ok: true });
  await flush();
  assert.equal(f.result.state, "rejected");
  assert.equal(f.result.error, failure);
  assert.equal(f.result.error.message, "AkuBridge content capture exceeded its bounded response deadline.");
  assert.equal(f.timers.size, 0);
});

test("cached pushed progress survives silent content diagnostics until the hard deadline", async () => {
  const f = fixture();
  await f.advance(0);
  assert.equal(f.push("extracting_block"), true);
  await f.advance(15_000);
  assert.equal(f.result.state, "rejected");
  assert.match(f.result.error.message, /Last content stage: \{"stage":"extracting_block","source":"instagram"\}\./);
  assert.equal(f.push("capture_completed", 2), false, "late producer cannot revive a disposed attempt");
});

test("actual timed-out capture retains reload activity until its underlying reply settles", async () => {
  const data = {};
  let reloads = 0;
  const coordinator = createReloadCoordinator({
    storage: { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, structuredClone(value)); } },
    inspect: async () => {}, reload: () => { reloads++; },
  });
  const f = fixture(undefined, coordinator);
  await f.advance(15_000);
  assert.equal(f.result.state, "rejected");
  await assert.rejects(coordinator.prepare("underlying-pending"), { code: "reload_busy" });
  f.capture.resolve({ ok: true }); await flush();
  await coordinator.prepare("underlying-settled");
  await coordinator.complete("underlying-settled");
  assert.equal(reloads, 1);
});
