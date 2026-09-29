import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../aku-browser-tab-bridge.js", import.meta.url), "utf8");
function hostFixture(send, request = () => new Promise(() => {})) {
  let tick, stopped = false;
  const status = { dataset: {}, textContent: "" };
  vm.runInNewContext(script, {
    window: { location: { origin: "http://127.0.0.1:11122", pathname: "/split-capture-host", hash: `#${"a".repeat(64)}` }, addEventListener: () => {} },
    document: { readyState: "complete", getElementById: () => status },
    chrome: { runtime: { sendMessage: send } },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { stopped = true; },
    setTimeout: () => 2, clearTimeout: () => {},
    fetch: request, AbortController, TextDecoder,
  });
  return { status, tick: () => tick(), stopped: () => stopped };
}

test("pre-split worker's undefined response becomes a bounded visible failure", async () => {
  let calls = 0;
  const f = hostFixture(async () => { calls++; return undefined; });
  await new Promise(setImmediate);
  assert.equal(f.status.dataset.state, "retrying");
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(calls, 6);
  assert.equal(f.stopped(), true);
  assert.equal(f.status.dataset.state, "failed");
  assert.match(f.status.textContent, /reload AkuBridge/);
  assert.doesNotMatch(f.status.textContent, /a{64}/);
});

test("network wake reconnects a suspended worker without running any host timer", async () => {
  let calls = 0, emit;
  const stream = new ReadableStream({ start(controller) { emit = (text) => controller.enqueue(new TextEncoder().encode(text)); } });
  const requests = [];
  const f = hostFixture(async () => { calls++; return { ok: true }; }, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, body: stream };
  });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  // Page timers are never advanced: model an idle, minimized host.
  emit("wa");
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  emit("ke\n");
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11122/api/bridge/split-capture/wake");
  assert.deepEqual(Object.keys(requests[0].options.headers), ["X-Aku-Capture-Instance"]);
  assert.equal(f.status.dataset.state, "connected");
});

test("wake channel rotation reconnects without a timer and rejection stops streaming", async () => {
  let requests = 0;
  hostFixture(async () => ({ ok: true }), async () => {
    requests++;
    return requests === 1
      ? { ok: true, status: 200, body: new ReadableStream({ start(c) { c.close(); } }) }
      : { ok: false, status: 403 };
  });
  await new Promise(setImmediate);
  assert.equal(requests, 2);
});

test("host requires an explicit positive split handshake", async () => {
  const f = hostFixture(async () => ({ ok: true }));
  await new Promise(setImmediate);
  assert.equal(f.status.dataset.state, "connected");
  assert.equal(f.stopped(), false);
});

test("Chrome patch upgrade selects a new registration entrypoint without duplicating worker logic", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "0.9.2.0");
  assert.equal(manifest.version_name, "0.9.2");
  assert.notEqual(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.background.service_worker, "service-worker-entry-v3.js");
  const entry = fs.readFileSync(new URL(`../${manifest.background.service_worker}`, import.meta.url), "utf8");
  assert.match(entry, /import "\.\/service-worker\.js";/);
  assert.doesNotMatch(entry, /onMessage\.addListener/);
});
