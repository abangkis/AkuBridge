import test from "node:test";
import assert from "node:assert/strict";
import { createReloadCoordinator } from "../reload-coordinator.js";
import { createSplitCaptureClient } from "../split-capture-client.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture({ inspect = async () => {}, data = {}, failWrite = false } = {}) {
  let reloads = 0;
  const storage = {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(value) { if (failWrite) throw Error("storage unavailable"); Object.assign(data, structuredClone(value)); },
  };
  const coordinator = createReloadCoordinator({ storage, inspect, reload: () => { reloads++; } });
  return { coordinator, storage, data, reloads: () => reloads };
}

test("reload fence precedes async inventory and lasts through acknowledgment", async () => {
  const inspection = deferred(), f = fixture({ inspect: () => inspection.promise });
  const preparing = f.coordinator.prepare("reload-A");
  let admitted = false;
  await assert.rejects(f.coordinator.run(() => { admitted = true; }), { code: "reload_busy" });
  await assert.rejects(f.coordinator.prepare("reload-B"), { code: "reload_busy" });
  inspection.resolve(); await preparing;
  await assert.rejects(f.coordinator.run(() => { admitted = true; }), { code: "reload_busy" });
  await f.coordinator.complete("reload-A", () => {
    assert.equal(f.reloads(), 0);
    assert.equal(f.data.akuBridgeReloadCoordinatorV1.fenced, true);
  });
  assert.equal(f.reloads(), 1);
  assert.equal(admitted, false);
  await assert.rejects(f.coordinator.complete("reload-A"), { code: "reload_busy" });
});

test("already admitted and still unsettled operations reject reload", async () => {
  const operation = deferred(), f = fixture();
  const capture = f.coordinator.run(() => operation.promise);
  await flush();
  // A controller timeout can stop waiting without settling this promise.
  await assert.rejects(f.coordinator.prepare("timeout-controller"), { code: "reload_busy" });
  assert.equal(f.reloads(), 0);
  operation.resolve(); await capture;
  await f.coordinator.prepare("settled");
  await f.coordinator.complete("settled");
  assert.equal(f.reloads(), 1);
});

test("surface inspection failure rejects reload and rolls back admission fence", async () => {
  const failure = Object.assign(Error("unverified cleanup"), { code: "cleanup_pending" });
  const f = fixture({ inspect: async () => { throw failure; } });
  await assert.rejects(f.coordinator.prepare("pending"), failure);
  assert.equal(await f.coordinator.run(() => 7), 7);
  assert.equal(f.reloads(), 0);
});

test("failed result acknowledgment cancels only the matching reload", async () => {
  const f = fixture();
  await f.coordinator.prepare("A");
  await f.coordinator.cancel("different");
  await assert.rejects(f.coordinator.run(() => {}), { code: "reload_busy" });
  await f.coordinator.cancel("A");
  assert.equal(await f.coordinator.run(() => 8), 8);
  await f.coordinator.prepare("B");
  await assert.rejects(f.coordinator.complete("B", () => { throw Error("ack failed"); }), /ack failed/);
  assert.equal(await f.coordinator.run(() => 9), 9);
  assert.equal(f.reloads(), 0);
});

test("worker restart never treats outstanding operations or a prepared reload as settled", async t => {
  for (const state of [{ active: 1, fenced: false, uncertain: false }, { active: 0, fenced: true, uncertain: false }]) {
    await t.test(JSON.stringify(state), async () => {
      const f = fixture({ data: { akuBridgeReloadCoordinatorV1: state } });
      await assert.rejects(f.coordinator.prepare("restart"), { code: "reload_busy" });
      await assert.rejects(f.coordinator.run(() => {}), { code: "reload_busy" });
      assert.equal(f.reloads(), 0);
    });
  }
});

test("failed storage cannot grant reload or start browser work", async () => {
  const f = fixture({ failWrite: true });
  let called = false;
  await assert.rejects(f.coordinator.run(() => { called = true; }), { code: "reload_state_unavailable" });
  await assert.rejects(f.coordinator.prepare("unsafe"), { code: "reload_state_unavailable" });
  assert.equal(called, false); assert.equal(f.reloads(), 0);
});

test("clean worker restart admits work without changing ownership identity", async () => {
  const f = fixture();
  await f.coordinator.run(() => {});
  const restarted = fixture({ data: f.data });
  await restarted.coordinator.prepare("clean");
  await restarted.coordinator.complete("clean");
  assert.equal(restarted.reloads(), 1);
});

test("failed activity persistence preserves the operation's first error and blocks later work", async () => {
  const data = {};
  let writes = 0;
  const first = Error("capture failed first");
  const coordinator = createReloadCoordinator({
    storage: { async get(key) { return { [key]: data[key] }; }, async set(value) {
      if (++writes > 1) throw Error("late storage failure"); Object.assign(data, value);
    } },
    inspect: async () => {}, reload() { assert.fail("must not reload"); },
  });
  await assert.rejects(coordinator.run(() => { throw first; }), error => error === first);
  await assert.rejects(coordinator.run(() => {}), { code: "reload_busy" });
});

test("actual direct reload handler accepts then acknowledges through the coordinator", async () => {
  const f = fixture(), events = [];
  const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const accept = worker.slice(worker.indexOf("async function acceptReloadSelf("), worker.indexOf("async function resumePendingSelfReload("));
  const handler = worker.slice(worker.indexOf('  if (message?.type === "AKU_BRIDGE_RELOAD_SELF")'), worker.indexOf('  if (message?.type === "AKU_BRIDGE_RELEASE_CAPTURE_SURFACE")'));
  const finished = deferred();
  const context = vm.createContext({
    reloadCoordinator: f.coordinator, PENDING_SELF_RELOAD_KEY: "pending", assertEndpoint() {},
    isAkuBrowserOrigin: () => true, bridgeHeaders: () => ({}),
    chrome: { storage: { local: { set: async () => {}, remove: async () => {} } } },
    fetch: async () => { events.push("accepted"); return { ok: true }; },
    message: { type: "AKU_BRIDGE_RELOAD_SELF", actionId: "direct", endpoint: "loopback", token: "fixture" },
    sender: { tab: { id: 9 } },
    sendResponse(response) { events.push(response.accepted ? "ack" : "rejected"); finished.resolve(); },
  });
  vm.runInContext(accept + "\n(function(){" + handler + "})();", context);
  await finished.promise; await flush();
  assert.deepEqual(events, ["accepted", "ack"]);
  assert.equal(f.reloads(), 1);
});

test("actual split reload retains the fence through result ACK and rolls back a failed ACK", async t => {
  for (const acknowledged of [true, false]) await t.test(String(acknowledged), async () => {
    const f = fixture(), ack = deferred(), stop = deferred();
    const key = "a".repeat(64), sender = { url: `http://127.0.0.1:11122/split-capture-host#${key}`, tab: { id: 1 } };
    let next = 0;
    const response = (status, value) => ({ status, ok: status === 200, json: async () => value });
    const client = createSplitCaptureClient({
      chrome: { storage: { session: f.storage } }, diagnostic() {}, setInterval: () => 1, clearInterval() {},
      reload: { complete: id => f.coordinator.complete(id), cancel: id => f.coordinator.cancel(id) },
      run: operation => f.coordinator.run(operation),
      handlers: { configure_background: async () => {}, reload_self: async a => { await f.coordinator.prepare(a.actionId); return { accepted: true }; } },
      fetch: async url => {
        if (url.endsWith("/bootstrap")) return response(200, { token: "t".repeat(64), instanceEpoch: "e" });
        if (url.endsWith("/next")) {
          if (next++ === 0) return response(200, { instanceEpoch: "e", action: { id: "split", actionId: "reload", type: "reload_self" } });
          await stop.promise; return response(410);
        }
        if (url.endsWith("/results/split")) { await ack.promise; return response(acknowledged ? 200 : 500); }
        throw Error("unexpected route");
      },
    });
    await client.connect({ key }, sender);
    await flush();
    await assert.rejects(f.coordinator.run(() => {}), { code: "reload_busy" });
    assert.equal(f.reloads(), 0);
    ack.resolve(); await flush();
    assert.equal(f.reloads(), acknowledged ? 1 : 0);
    if (!acknowledged) assert.equal(await f.coordinator.run(() => "resumed"), "resumed");
    stop.resolve(); await flush();
  });
});
