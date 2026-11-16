import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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

function fixture(diagnostics = () => new Promise(() => {})) {
  const capture = deferred(), timers = new Map(), requests = [];
  let now = 0, nextId = 0;
  const context = vm.createContext({
    collectFromTab: () => capture.promise,
    chrome: { tabs: { sendMessage(tabId, message) {
      requests.push({ tabId, ...message });
      return diagnostics();
    } } },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(deadline, context);
  const result = { state: "pending" };
  context.collectFromTabWithDeadline(42, { captureTimeoutMs: 10_000 }).then(
    value => Object.assign(result, { state: "fulfilled", value }),
    error => Object.assign(result, { state: "rejected", error }),
  );
  return {
    capture, requests, result, timers,
    async advance(milliseconds) {
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
  const f = fixture(async () => ({ diagnostics: { stage: "extracting" } }));
  await f.advance(15_000);
  assert.equal(f.result.state, "rejected");
  assert.match(f.result.error.message, /Last content stage: \{"stage":"extracting"\}\./);
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
