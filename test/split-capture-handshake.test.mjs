import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../aku-browser-tab-bridge.js", import.meta.url), "utf8");
function hostFixture(send) {
  let tick, stopped = false;
  const status = { dataset: {}, textContent: "" };
  vm.runInNewContext(script, {
    window: { location: { origin: "http://127.0.0.1:11122", pathname: "/split-capture-host", hash: `#${"a".repeat(64)}` } },
    document: { readyState: "complete", getElementById: () => status },
    chrome: { runtime: { sendMessage: send } },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { stopped = true; },
    setTimeout: () => 2, clearTimeout: () => {},
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
