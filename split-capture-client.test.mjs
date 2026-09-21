import test from "node:test";
import assert from "node:assert/strict";
import { createSplitCaptureClient } from "./split-capture-client.js";

const key = "a".repeat(64);
const endpoint = "http://127.0.0.1:11122";
const sender = { url: `${endpoint}/split-capture-host#${key}`, tab: { id: 42 } };
const response = (status, value = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
function chromeFixture() {
  const values = {};
  return {
    storage: { session: {
      get: async (k) => ({ [k]: values[k] }), set: async (v) => Object.assign(values, v), remove: async (k) => { delete values[k]; },
    } },
    tabs: { get: async () => ({ id: 42, url: sender.url }) },
    runtime: { reload() {} },
  };
}

test("split capture rejects source pages, wrong fragments and missing tab ownership before network", async () => {
  let calls = 0;
  const client = createSplitCaptureClient({ chrome: chromeFixture(), fetch: async () => { calls++; }, handlers: {} });
  for (const value of [
    { ...sender, url: "https://x.com/home" },
    { ...sender, url: `${endpoint}/#${key}` },
    { ...sender, url: `${endpoint}/split-capture-host#wrong` },
    { ...sender, tab: {} },
  ]) await assert.rejects(client.connect({ key }, value), /Invalid capture host/);
  assert.equal(calls, 0);
  assert.deepEqual(client.headers(), {});
});

test("typed action roundtrip uses bootstrapped token and instance fencing, never UI-supplied credentials", async () => {
  const calls = [];
  let finish;
  const finished = new Promise((r) => { finish = r; });
  let nextCount = 0;
  let seenConfig;
  const client = createSplitCaptureClient({ chrome: chromeFixture(), handlers: {
    configure_background: async () => ({}),
    probe_source_sessions: async (_a, c) => { seenConfig = c; return { sessions: { x: { state: "ready" } } }; },
  }, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/bootstrap")) return response(200, { token: "t".repeat(64), instanceEpoch: "epoch-123" });
    if (url.endsWith("/next")) {
      if (nextCount++ === 0) return response(200, { instanceEpoch: "epoch-123", action: { id: "one", type: "probe_source_sessions", token: "untrusted" } });
      await finished; return response(410);
    }
    if (url.endsWith("/results/one")) { finish(); return response(204); }
    throw new Error(`unexpected URL: ${url}`);
  } });
  assert.deepEqual(await client.connect({ key }, sender), { ok: true });
  await finished;
  assert.equal(seenConfig.token, "t".repeat(64));
  const result = calls.find((c) => c.url.endsWith("/results/one"));
  assert.equal(result.options.headers["X-Aku-Capture-Instance"], key);
  assert.equal(result.options.headers["X-Aku-Bridge-Token"], "t".repeat(64));
  assert.deepEqual(JSON.parse(result.options.body), { ok: true, result: { sessions: { x: { state: "ready" } } } });
});

test("epoch mismatch stops polling without executing or replaying an action", async () => {
  let executed = false;
  let finished;
  const stopped = new Promise((r) => { finished = r; });
  const chrome = chromeFixture();
  chrome.storage.session.remove = async () => finished();
  const client = createSplitCaptureClient({ chrome, handlers: {
    configure_background: async () => ({}), dispatch: async () => { executed = true; },
  }, fetch: async (url) => url.endsWith("/bootstrap")
    ? response(200, { token: "t".repeat(64), instanceEpoch: "epoch-123" })
    : response(200, { instanceEpoch: "old-epoch", action: { id: "old", type: "dispatch" } }),
  });
  await client.connect({ key }, sender); await stopped;
  assert.equal(executed, false);
  assert.deepEqual(client.headers(), {});
});

test("failed background handshake is retried rather than cached as connected", async () => {
  let configured = 0;
  let bootstraps = 0;
  let stopped;
  const finished = new Promise((resolve) => { stopped = resolve; });
  const chrome = chromeFixture();
  chrome.storage.session.remove = async () => { if (configured > 1) stopped(); };
  const client = createSplitCaptureClient({ chrome, handlers: {
    configure_background: async () => {
      if (++configured === 1) throw new Error("transient heartbeat failure");
    },
  }, fetch: async (url) => {
    if (url.endsWith("/bootstrap")) { bootstraps++; return response(200, { token: "t".repeat(64), instanceEpoch: "epoch-123" }); }
    return response(410);
  } });
  await assert.rejects(client.connect({ key }, sender), /transient heartbeat failure/);
  assert.deepEqual(client.headers(), {});
  assert.deepEqual(await client.connect({ key }, sender), { ok: true });
  await finished;
  assert.equal(configured, 2);
  assert.equal(bootstraps, 2);
});
