import test from "node:test";
import assert from "node:assert/strict";
import { createSplitCaptureClient } from "./split-capture-client.js";

const key = "a".repeat(64);
const endpoint = "http://127.0.0.1:11122";
const sender = { url: `${endpoint}/split-capture-host#${key}`, tab: { id: 42 } };
const response = (status, value = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

for (const advertised of [true, false]) {
  test(`source lifetime handshake is negotiated: ${advertised}`, async () => {
    let next = 0, prepareCalls = 0, finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const client = createSplitCaptureClient({ chrome: chromeFixture(), diagnostic: () => {}, handlers: {
      configure_background: async () => {},
      open_source: async (_action, context) => {
        if (advertised) {
          assert.equal(context.sourceIntent.url, `${endpoint}/split-source-intent?id=split_source`);
          await context.sourceIntent.prepare();
        } else assert.equal(context.sourceIntent, undefined);
      },
    }, fetch: async (url, options) => {
      if (url.endsWith("/bootstrap")) {
        assert.deepEqual(JSON.parse(options.body), { sourceWindowLifetime: 1, captureHostClose: 1 });
        assert.equal(options.headers["Content-Type"], "application/json");
        return response(200, { token: "t".repeat(64), instanceEpoch: "epoch" });
      }
      if (url.endsWith("/next")) {
        if (next++ === 0) return response(200, { instanceEpoch: "epoch", sourceWindowLifetime: advertised, action: { id: "split_source", type: "open_source" } });
        await finished; return response(410);
      }
      if (url.includes("/source/prepare/")) {
        prepareCalls++;
        assert.equal(options.headers["X-Aku-Capture-Instance"], key);
        assert.equal(options.headers["X-Aku-Bridge-Token"], "t".repeat(64));
        return response(200);
      }
      if (url.endsWith("/results/split_source")) {
        assert.equal(JSON.parse(options.body).ok, true);
        finish(); return response(204);
      }
      throw Error("unexpected request");
    } });
    await client.connect({ key }, sender);
    await finished;
    assert.equal(prepareCalls, advertised ? 1 : 0);
  });
}
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

function heartbeatFixture() {
  const chrome = chromeFixture();
  const timers = new Map();
  let timerID = 0, tabCalls = 0, bootstraps = 0;
  let tab = { id: 42, url: sender.url };
  const polls = [];
  chrome.tabs.get = async () => { tabCalls++; if (!tab) throw new Error("Tab closed"); return tab; };
  const client = createSplitCaptureClient({
    chrome, diagnostic: () => {}, handlers: { configure_background: async () => {} },
    setInterval: (fn, ms) => { assert.equal(ms, 20_000); timers.set(++timerID, fn); return timerID; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url.endsWith("/bootstrap")) { bootstraps++; return response(200, { token: "t".repeat(64), instanceEpoch: "epoch" }); }
      return new Promise((resolve, reject) => {
        polls.push(resolve);
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  return { client, timers, polls, setTab: value => { tab = value; }, tabCalls: () => tabCalls, bootstraps: () => bootstraps,
    tick: async () => { for (const fn of timers.values()) fn(); await new Promise(setImmediate); },
  };
}

test("validated split session keeps worker active beyond 30s with one timer across CONNECT and restore", async () => {
  const f = heartbeatFixture();
  await f.client.connect({ key }, sender);
  await f.client.connect({ key }, sender);
  await f.client.restore();
  assert.equal(f.timers.size, 1);
  assert.equal(f.bootstraps(), 1);
  const before = f.tabCalls();
  await f.tick(); // 20s
  await f.tick(); // 40s, without any content-script messages
  await f.tick(); // 60s
  assert.equal(f.tabCalls() - before, 3);
  f.setTab(null);
  await f.tick();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.client.headers(), {});
});

test("navigated host clears heartbeat and rejects late poll actions", async () => {
  const f = heartbeatFixture();
  await f.client.connect({ key }, sender);
  f.setTab({ id: 42, url: "https://x.com/home" });
  await f.tick();
  assert.equal(f.timers.size, 0);
  f.polls[0](response(200, { instanceEpoch: "epoch", action: { id: "late", type: "dispatch" } }));
  await new Promise(setImmediate);
  assert.deepEqual(f.client.headers(), {});
  assert.equal(f.polls.length, 1);
});

test("terminal status and epoch mismatch clear the session heartbeat", async () => {
  for (const value of [response(410), response(200, { instanceEpoch: "stale", action: { id: "old" } })]) {
    const f = heartbeatFixture();
    await f.client.connect({ key }, sender);
    f.polls[0](value);
    await new Promise(setImmediate);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.client.headers(), {});
  }
});

test("replacement capture capability replaces heartbeat and aborts the old poll", async () => {
  const f = heartbeatFixture();
  await f.client.connect({ key }, sender);
  const oldTimer = [...f.timers.keys()][0];
  const newKey = "b".repeat(64);
  const newSender = { url: `${endpoint}/split-capture-host#${newKey}`, tab: { id: 42 } };
  f.setTab({ id: 42, url: newSender.url });
  await f.client.connect({ key: newKey }, newSender);
  await new Promise(setImmediate);
  assert.equal(f.timers.size, 1);
  assert.equal(f.timers.has(oldTimer), false);
  assert.equal(f.polls.length, 2);
  assert.equal(f.client.headers()["X-Aku-Capture-Instance"], newKey);
  f.setTab(null);
  await f.tick();
  assert.equal(f.timers.size, 0);
});

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
  const diagnostics = [];
  let finish;
  const finished = new Promise((r) => { finish = r; });
  let nextCount = 0;
  let seenConfig;
  const client = createSplitCaptureClient({ chrome: chromeFixture(), diagnostic: event => diagnostics.push(event), handlers: {
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
  assert.ok(diagnostics.some(event => event.phase === "action_claimed" && event.actionId === "one"));
  assert.ok(!JSON.stringify(diagnostics).includes(key));
  assert.ok(!JSON.stringify(diagnostics).includes("t".repeat(64)));
});

test("poll diagnostics record a timeout before retrying without exposing credentials", async () => {
  const diagnostics = [];
  const chrome = chromeFixture();
  let stopped;
  const finished = new Promise(resolve => { stopped = resolve; });
  chrome.storage.session.remove = async () => stopped();
  let polls = 0;
  const client = createSplitCaptureClient({ chrome, diagnostic: event => diagnostics.push(event), delay: async () => {}, handlers: {
    configure_background: async () => ({}),
  }, fetch: async url => {
    if (url.endsWith("/bootstrap")) return response(200, { token: "t".repeat(64), instanceEpoch: "epoch" });
    if (polls++ === 0) throw Object.assign(new Error("private endpoint"), { name: "TimeoutError" });
    return response(410);
  } });
  await client.connect({ key }, sender);
  await finished;
  assert.ok(diagnostics.some(event => event.phase === "request_error" && event.kind === "timeout"));
  assert.ok(diagnostics.some(event => event.phase === "poll_stopped" && event.status === 410));
  assert.ok(!JSON.stringify(diagnostics).includes("private endpoint"));
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

test("only explicit reader action receives authenticated prepare and foreground capability", async () => {
  const calls = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let next = 0;
  const client = createSplitCaptureClient({ chrome: chromeFixture(), handlers: {
    configure_background: async (_a, c) => { assert.equal(c.readerIntent, undefined); },
    open_native_post: async (_a, c) => {
      assert.equal(c.readerIntent.url, `${endpoint}/split-reader-intent?id=split_reader`);
      await c.readerIntent.prepare();
      await c.readerIntent.foreground();
      return { state: "native_post_opened" };
    },
  }, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/bootstrap")) return response(200, { token: "t".repeat(64), instanceEpoch: "epoch" });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, { instanceEpoch: "epoch", action: { id: "split_reader", type: "open_native_post" } });
      await finished; return response(410);
    }
    if (url.includes("/reader/")) return response(200);
    if (url.endsWith("/results/split_reader")) { finish(); return response(204); }
    throw new Error(`unexpected ${url}`);
  } });
  await client.connect({ key }, sender);
  await finished;
  const native = calls.filter((c) => c.url.includes("/reader/"));
  assert.equal(native.length, 2);
  for (const call of native) {
    assert.equal(call.options.headers["X-Aku-Capture-Instance"], key);
    assert.equal(call.options.headers["X-Aku-Bridge-Token"], "t".repeat(64));
  }
});

test("capture-host close ACKs before removing only the exact authenticated host tab", async () => {
  const calls = [];
  const chrome = chromeFixture();
  let removed = [];
  chrome.tabs.remove = async (id) => { removed.push(id); };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let next = 0;
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {},
    close_capture_host: async (_action, context) => {
      assert.equal(context.tabId, sender.tab.id);
      return { retired: { closedTabs: 2, preservedTabs: 1 } };
    },
  }, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      await finished;
      return response(410);
    }
    if (url.endsWith("/results/close")) {
      assert.deepEqual(removed, [], "host remains open until the ACK succeeds");
      assert.deepEqual(JSON.parse(options.body), {
        ok: true, result: { retired: { closedTabs: 2, preservedTabs: 1 } },
      });
      assert.equal(options.headers["X-Aku-Capture-Instance"], key);
      finish();
      return response(204);
    }
    throw new Error(`unexpected URL: ${url}`);
  } });

  await client.connect({ key }, sender);
  await finished;
  for (let i = 0; i < 10 && removed.length === 0; i++) await new Promise(setImmediate);
  assert.deepEqual(removed, [sender.tab.id]);
  assert.equal(calls[0].options.body, JSON.stringify({ sourceWindowLifetime: 1, captureHostClose: 1 }));
});

test("close capability must be negotiated by bootstrap and the claimed action envelope", async () => {
  for (const [bootstrapCapability, actionCapability] of [[false, true], [true, false]]) {
    const chrome = chromeFixture();
    let removed = false, reported;
    chrome.tabs.remove = async () => { removed = true; };
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    let next = 0;
    const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
      configure_background: async () => {},
      close_capture_host: async () => { throw new Error("must not run without negotiation"); },
    }, fetch: async (url, options) => {
      if (url.endsWith("/bootstrap")) return response(200, {
        token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: bootstrapCapability,
      });
      if (url.endsWith("/next")) {
        if (next++ === 0) return response(200, {
          instanceEpoch: "epoch", captureHostClose: actionCapability,
          action: { id: "close", type: "close_capture_host" },
        });
        await finished;
        return response(410);
      }
      if (url.endsWith("/results/close")) {
        reported = JSON.parse(options.body);
        finish();
        return response(204);
      }
      throw new Error(`unexpected URL: ${url}`);
    } });
    await client.connect({ key }, sender);
    await finished;
    assert.equal(removed, false);
    assert.deepEqual(reported, { ok: false, message: "Capture host close is not negotiated." });
  }
});

test("failed result ACK leaves the authenticated capture host open", async () => {
  const chrome = chromeFixture();
  let removed = false, finish;
  chrome.tabs.remove = async () => { removed = true; };
  const finished = new Promise((resolve) => { finish = resolve; });
  let next = 0;
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {}, close_capture_host: async () => ({ retired: {} }),
  }, fetch: async (url) => {
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      await finished;
      return response(410);
    }
    if (url.endsWith("/results/close")) { finish(); return response(500); }
    throw new Error(`unexpected URL: ${url}`);
  } });
  await client.connect({ key }, sender);
  await finished;
  await new Promise(setImmediate);
  assert.equal(removed, false);
});

test("close preserves a host tab whose URL changed before post-ACK revalidation", async () => {
  const chrome = chromeFixture();
  let removed = false, finish;
  let host = { id: sender.tab.id, url: sender.url };
  chrome.tabs.get = async () => host;
  chrome.tabs.remove = async () => { removed = true; };
  const finished = new Promise((resolve) => { finish = resolve; });
  let next = 0;
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {}, close_capture_host: async () => ({ retired: {} }),
  }, fetch: async (url) => {
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      await finished;
      return response(410);
    }
    if (url.endsWith("/results/close")) {
      host = { id: sender.tab.id, url: "https://x.com/home" };
      finish();
      return response(204);
    }
    throw new Error(`unexpected URL: ${url}`);
  } });
  await client.connect({ key }, sender);
  await finished;
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal(removed, false);
});

test("host navigation before close action prevents background retirement", async () => {
  const chrome = chromeFixture();
  let removed = false, handlerCalls = 0, reported, finish;
  chrome.tabs.get = async () => ({
    id: sender.tab.id, url: sender.url, pendingUrl: "https://x.com/home",
  });
  chrome.tabs.remove = async () => { removed = true; };
  const finished = new Promise((resolve) => { finish = resolve; });
  let next = 0;
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {},
    close_capture_host: async () => { handlerCalls++; return {}; },
  }, fetch: async (url, options) => {
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      await finished;
      return response(410);
    }
    if (url.endsWith("/results/close")) {
      reported = JSON.parse(options.body);
      finish();
      return response(204);
    }
    throw new Error(`unexpected URL: ${url}`);
  } });
  await client.connect({ key }, sender);
  await finished;
  await new Promise(setImmediate);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(reported, { ok: false, message: "Capture host identity changed." });
  assert.equal(removed, false);
});

test("capture-host tab read cannot remove a tab after session rotation", async () => {
  const chrome = chromeFixture();
  let host = { id: sender.tab.id, url: sender.url };
  let removeCalls = 0, releaseHostRead, hostReadStarted, finishAck;
  const reading = new Promise((resolve) => { hostReadStarted = resolve; });
  const acked = new Promise((resolve) => { finishAck = resolve; });
  let holdRead = false, next = 0, heartbeat;
  chrome.tabs.get = async () => {
    if (holdRead) {
      hostReadStarted();
      return new Promise((resolve) => { releaseHostRead = () => resolve(host); });
    }
    return host;
  };
  chrome.tabs.remove = async () => { removeCalls++; };
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {}, close_capture_host: async () => ({}),
  }, setInterval: (fn) => { heartbeat = fn; return 1; }, clearInterval: () => {}, fetch: async (url) => {
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      if (next === 2) return new Promise(() => {});
      return response(410);
    }
    if (url.endsWith("/results/close")) {
      holdRead = true;
      finishAck();
      return response(204);
    }
    throw new Error(`unexpected URL: ${url}`);
  } });
  await client.connect({ key }, sender);
  await acked;
  await reading;

  const nextKey = "b".repeat(64);
  host = { id: sender.tab.id, url: `${endpoint}/split-capture-host#${nextKey}` };
  await client.connect({ key: nextKey }, { url: host.url, tab: sender.tab });
  releaseHostRead();
  await new Promise(setImmediate);
  assert.equal(removeCalls, 0);
  host = { id: sender.tab.id, url: "https://x.com/home" };
  holdRead = false;
  heartbeat();
  await new Promise(setImmediate);
});

test("host-tab removal failure leaves the authenticated session pending", async () => {
  const chrome = chromeFixture();
  let finishAck, next = 0, heartbeat;
  const acked = new Promise((resolve) => { finishAck = resolve; });
  chrome.tabs.remove = async () => { throw new Error("Chrome did not close the tab"); };
  const client = createSplitCaptureClient({ chrome, diagnostic: () => {}, handlers: {
    configure_background: async () => {}, close_capture_host: async () => ({}),
  }, setInterval: (fn) => { heartbeat = fn; return 1; }, clearInterval: () => {}, fetch: async (url) => {
    if (url.endsWith("/bootstrap")) return response(200, {
      token: "t".repeat(64), instanceEpoch: "epoch", captureHostClose: true,
    });
    if (url.endsWith("/next")) {
      if (next++ === 0) return response(200, {
        instanceEpoch: "epoch", captureHostClose: true,
        action: { id: "close", type: "close_capture_host" },
      });
      return new Promise(() => {});
    }
    if (url.endsWith("/results/close")) { finishAck(); return response(204); }
    throw new Error(`unexpected URL: ${url}`);
  } });
  await client.connect({ key }, sender);
  await acked;
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal(client.headers()["X-Aku-Capture-Instance"], key);
  assert.equal(typeof heartbeat, "function");
  // End the fake session after proving a failed close did not clear ownership.
  chrome.tabs.get = async () => ({ id: sender.tab.id, url: "https://x.com/home" });
  heartbeat();
  await new Promise(setImmediate);
  assert.deepEqual(client.headers(), {});
});
