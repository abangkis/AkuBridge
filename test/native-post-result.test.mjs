import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const manualMessage = "The post opened in your Native Reader tab. Switch to that window manually.";

test("service worker preserves manual foreground status from its reader result", async () => {
  const worker = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const start = worker.indexOf("async function openNativePostInReaderWindow(");
  const end = worker.indexOf("async function probeSourceFreshness(", start);
  const opened = [];
  const context = {
    URL,
    sourceIds: () => ["x"],
    sourceForUrl: () => "x",
    isNativePostUrl: () => true,
    managedCaptureWindow: { windowIds: async () => [9] },
    readerWindow: { open: async (url, options) => {
      opened.push({ url, options });
      return { url, foreground: "manual_required", message: manualMessage };
    } },
  };
  vm.createContext(context);
  vm.runInContext(worker.slice(start, end), context);
  const result = await context.openNativePostInReaderWindow("x", "https://x.com/a/status/1");
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{
    url: "https://x.com/a/status/1",
    options: { excludedWindowIds: [9], readerIntent: null },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    source: "x", state: "native_post_opened", url: "https://x.com/a/status/1",
    foreground: "manual_required", message: manualMessage,
  });
});

test("tab bridge relays manual foreground status to the AkuBrowser page", async () => {
  const relay = fs.readFileSync(new URL("../aku-browser-tab-bridge.js", import.meta.url), "utf8");
  const origin = "http://127.0.0.1:11122";
  const messages = [];
  const requests = [];
  let listener;
  const window = {
    location: { origin, pathname: "/" },
    addEventListener(type, callback) { if (type === "message") listener = callback; },
    postMessage(message) { messages.push(message); },
  };
  const context = {
    window,
    chrome: { runtime: { sendMessage: async (message) => {
      requests.push(message);
      return {
        ok: true, source: "x", url: "https://x.com/a/status/1",
        foreground: "manual_required", message: manualMessage,
      };
    } } },
  };
  vm.runInNewContext(relay, context);
  await listener({ source: window, origin, data: {
    type: "AKU_BROWSER_OPEN_NATIVE_POST", requestId: "broker_" + "a".repeat(32),
    source: "x", url: "https://x.com/a/status/1",
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    type: "AKU_BRIDGE_OPEN_NATIVE_POST", source: "x", url: "https://x.com/a/status/1",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "AKU_BROWSER_NATIVE_POST_OPENED", requestId: "broker_" + "a".repeat(32),
    source: "x", url: "https://x.com/a/status/1", foreground: "manual_required", message: manualMessage,
  }]);
});
