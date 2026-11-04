import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  BRIDGE_ID, BRIDGE_CONTRACT_VERSION, bridgeCapabilitiesForProtocol, createBridgeCapabilities,
} from "../bridge-capabilities.js";
import { captureSurfacePolicyIdentity } from "../capture-surface-policy.js";

const relay = fs.readFileSync(new URL("../aku-browser-tab-bridge.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const surfacePolicy = await captureSurfacePolicyIdentity();
const origin = "http://127.0.0.1:11122";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const observedAt = "2026-11-04T00:00:00.000Z";
const readiness = { x: { permissionGranted: true, readinessState: "readable" } };
const wire = (value) => JSON.parse(JSON.stringify(value));
const baseCapabilities = () => ({ ...createBridgeCapabilities(manifest), futureReadOnlyField: { retained: true } });
const completeCapabilities = () => ({
  ...baseCapabilities(), captureSurfacePolicy: surfacePolicy,
  sourceAccess: { grantedSources: ["x"], sources: readiness, observedAt },
});

// Execute the existing private caller declarations with synthetic external
// ports, as in the native-post caller tests; do not export production authority.
function declaration(name) {
  const match = worker.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `Production declaration missing: ${name}`);
  return match[0];
}

function loopback(capabilities, pageOrigin = origin, failure) {
  const messages = [], calls = [];
  let listener;
  const window = {
    location: { origin: pageOrigin, pathname: "/" },
    addEventListener(type, callback) { if (type === "message") listener = callback; },
    postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
  };
  vm.runInNewContext(relay, {
    window, chrome: { runtime: {
      getURL: () => `${extensionOrigin}/`,
      sendMessage: async (message) => {
        calls.push(wire(message));
        if (failure) throw failure;
        return capabilities === undefined ? undefined : { capabilities };
      },
    } },
  });
  return {
    window, messages, calls,
    ping: (protocolMajor, event = {}) => listener?.({
      source: window, origin: pageOrigin,
      data: { type: "AKU_BROWSER_BRIDGE_PING", ...(protocolMajor === undefined ? {} : { protocolMajor }) },
      ...event,
    }),
  };
}

function background(protocolMajor, response = { ok: true, status: 202 }) {
  const requests = [], effects = [];
  const owner = "1".repeat(64), token = "synthetic-bridge-token-".repeat(3);
  const context = {
    BRIDGE_ID, BRIDGE_CONTRACT_VERSION, bridgeCapabilitiesForProtocol,
    BACKGROUND_DISPATCH_CONFIG_KEY: "syntheticBackgroundConfig",
    BACKGROUND_DISPATCH_ALARM: "syntheticBackgroundAlarm",
    splitCaptureClient: { headers: () => ({ "X-Aku-Capture-Instance": owner }) },
    createBridgeCapabilities: baseCapabilities,
    captureSurfacePolicyIdentity: async () => wire(surfacePolicy),
    sourceAccessReadiness: async () => wire(readiness),
    sourcesForGrantedOrigins: (origins) => { assert.deepEqual(wire(origins), ["https://x.com/*"]); return ["x"]; },
    Date: class extends Date { constructor() { super(observedAt); } },
    chrome: {
      runtime: { getManifest: () => manifest },
      permissions: { getAll: async () => ({ origins: ["https://x.com/*"] }) },
      storage: { local: { remove: async (key) => { effects.push(["remove", key]); } } },
      alarms: { clear: async (key) => { effects.push(["clear", key]); } },
    },
    fetch: async (url, options) => {
      requests.push({ url, options: wire(options) });
      return { ...response, json: async () => ({ message: "synthetic heartbeat failure" }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(["bridgeCapabilities", "bridgeCapabilitiesWithSourceAccess", "bridgeHeaders", "responseError", "refreshBackgroundHeartbeat"]
    .map(declaration).join("\n"), context);
  return {
    requests, effects, owner, token,
    refresh: () => context.refreshBackgroundHeartbeat({ endpoint: origin, token, sidecarProtocolMajor: protocolMajor }),
  };
}

test("background heartbeat binds the shared ESM projector without replacing the classic relay", () => {
  assert.match(worker, /import\s*\{[^}]*\bbridgeCapabilitiesForProtocol\b[^}]*\}\s*from "\.\/bridge-capabilities\.js"/);
  assert.ok(manifest.content_scripts.some((entry) => entry.js.includes("aku-browser-tab-bridge.js")));
});

for (const protocol of [2, 0, undefined, 1, 3, "2", null]) {
  test(`actual loopback and background callers preserve protocol ${JSON.stringify(protocol)}`, async () => {
    const capabilities = completeCapabilities(), before = wire(capabilities);
    const relayFixture = loopback(capabilities);
    await relayFixture.ping(protocol);
    assert.deepEqual(relayFixture.calls, [{ type: "AKU_BRIDGE_GET_CAPABILITIES" }]);
    assert.equal(relayFixture.messages.length, 1);
    const reply = relayFixture.messages[0];
    assert.equal(reply.targetOrigin, origin);
    assert.equal(reply.message.type, "AKU_BROWSER_BRIDGE_READY");
    assert.equal(reply.message.extensionOrigin, extensionOrigin);

    const heartbeat = background(protocol);
    assert.equal(await heartbeat.refresh(), true);
    assert.deepEqual(heartbeat.effects, []);
    assert.equal(heartbeat.requests.length, 1);
    const request = heartbeat.requests[0];
    assert.equal(request.url, `${origin}/api/bridge/heartbeat`);
    assert.equal(request.options.method, "POST");
    assert.deepEqual(request.options.headers, {
      "X-Aku-Capture-Instance": heartbeat.owner, "X-Aku-Bridge-Token": heartbeat.token,
      "X-Aku-Bridge-Id": BRIDGE_ID, "X-Aku-Bridge-Contract": BRIDGE_CONTRACT_VERSION, "Content-Type": "application/json",
    });
    const body = JSON.parse(request.options.body);
    assert.deepEqual(Object.keys(body), ["capabilities"]);
    const loopbackValue = wire(reply.message.capabilities);
    if (protocol === 2) {
      assert.strictEqual(reply.message.capabilities, capabilities);
      assert.deepEqual(loopbackValue, before);
      assert.deepEqual(body.capabilities, before);
    } else {
      const expectedLoopback = { ...before };
      delete expectedLoopback.protocolMajor;
      delete expectedLoopback.protocolMinor;
      delete expectedLoopback.updateCapabilities;
      const expectedBackground = { ...expectedLoopback };
      delete expectedBackground.focusPolicyRevision;
      assert.deepEqual(loopbackValue, expectedLoopback);
      assert.deepEqual(body.capabilities, expectedBackground);
      assert.equal(loopbackValue.focusPolicyRevision, before.focusPolicyRevision);
      assert.equal(Object.hasOwn(body.capabilities, "focusPolicyRevision"), false);
    }
    assert.deepEqual(capabilities, before);
  });
}

for (const kind of ["foreign source", "foreign origin", "missing data", "unknown message"]) {
  test(`loopback capability handshake ignores ${kind}`, async () => {
    const fixture = loopback(completeCapabilities());
    const event = kind === "foreign source" ? { source: {} }
      : kind === "foreign origin" ? { origin: "https://untrusted.invalid" }
        : kind === "missing data" ? { data: null } : { data: { type: "UNKNOWN" } };
    await fixture.ping(2, event);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.messages, []);
  });
}

test("loopback capability handshake does not register on an untrusted page", async () => {
  const fixture = loopback(completeCapabilities(), "https://untrusted.invalid");
  await fixture.ping(2);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.messages, []);
});

for (const failure of [undefined, new Error("synthetic capability error")]) {
  test(`loopback preserves its bounded error envelope for ${failure ? "a rejected request" : "missing capabilities"}`, async () => {
    const fixture = loopback(undefined, origin, failure);
    await fixture.ping(2);
    assert.deepEqual(wire(fixture.messages), [{
      message: { type: "AKU_BROWSER_BRIDGE_ERROR", message: failure?.message ?? "AkuBridge capability handshake returned no capabilities." },
      targetOrigin: origin,
    }]);
  });
}

for (const status of [401, 403]) {
  test(`background heartbeat retires authorization in order after HTTP ${status}`, async () => {
    const fixture = background(2, { ok: false, status });
    assert.equal(await fixture.refresh(), false);
    assert.deepEqual(fixture.effects, [["remove", "syntheticBackgroundConfig"], ["clear", "syntheticBackgroundAlarm"]]);
  });
}

test("background heartbeat preserves a delivery failure without clearing authorization", async () => {
  const fixture = background(2, { ok: false, status: 500 });
  await assert.rejects(fixture.refresh(), /synthetic heartbeat failure/);
  assert.deepEqual(fixture.effects, []);
});
