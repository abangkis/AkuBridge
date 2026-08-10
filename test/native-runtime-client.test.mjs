import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_CODEX_STATE_KEY,
  NATIVE_RUNTIME_CLIENT_STATES,
  NATIVE_RUNTIME_HOST,
  NATIVE_RUNTIME_STATE_KEY,
  createNativeRuntimeClient,
  probeCompatibleLoopbackRuntime,
} from "../native-runtime-client.js";

const FIXED_NOW = Date.parse("2026-07-28T10:00:00.000Z");
const FIXED_REQUEST_ID = "runtime-request-0001";

test("native runtime request carries only the bounded AkuBrowser identity contract", async () => {
  let observedHost;
  let observedRequest;
  const { client, storageWrites } = clientWithResponder((host, request, callback) => {
    observedHost = host;
    observedRequest = request;
    callback(readyResponse(request));
  });

  const outcome = await client.ensureRuntime({ trigger: "startup" });

  assert.equal(observedHost, NATIVE_RUNTIME_HOST);
  assert.deepEqual(observedRequest, {
    schemaVersion: 1,
    kind: "request",
    requestId: FIXED_REQUEST_ID,
    action: "ensure_runtime",
    extension: {
      product: "AkuBrowser",
      productVersion: "0.7.4",
      runtimeRevision: "source-adapters-v89",
      bridgeContractVersion: "aku-browser.bridge.v2",
    },
  });
  assert.equal(outcome.state, NATIVE_RUNTIME_CLIENT_STATES.READY);
  assert.equal(storageWrites.length, 2);
  assert.deepEqual(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], {
    schemaVersion: 1,
    state: "runtime_ready",
    trigger: "startup",
    observedAt: "2026-07-28T10:00:00.000Z",
    status: "ready",
    retryable: false,
    remediation: "none",
  });
});

test("missing registered host becomes install-required state without throwing", async () => {
  const { client, storageWrites, runtime } = clientWithResponder((_host, _request, callback) => {
    runtime.lastError = { message: "Specified native messaging host not found." };
    callback(undefined);
    runtime.lastError = undefined;
  });

  const outcome = await client.ensureRuntime({ trigger: "installed_install" });

  assert.deepEqual(outcome, {
    schemaVersion: 1,
    state: "runtime_install_required",
    trigger: "installed_install",
    observedAt: "2026-07-28T10:00:00.000Z",
    errorCode: "native_host_not_found",
    retryable: false,
    remediation: "install_runtime",
  });
  assert.deepEqual(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], outcome);
});

test("a native host held by security software times out instead of hanging setup", async () => {
  const storageWrites = [];
  const client = createNativeRuntimeClient({
    runtime: {
      sendNativeMessage() {},
    },
    storage: {
      async set(value) {
        storageWrites.push(structuredClone(value));
      },
    },
    productVersion: "0.7.9",
    runtimeRevision: "source-adapters-v87",
    now: () => FIXED_NOW,
    randomUUID: () => FIXED_REQUEST_ID,
    nativeMessageTimeoutMs: 1_000,
  });

  const outcome = await client.status({ trigger: "setup_check", timeoutMs: 5 });

  assert.equal(outcome.state, "runtime_failed");
  assert.equal(outcome.errorCode, "native_message_failed");
  assert.equal(outcome.retryable, true);
  assert.deepEqual(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], outcome);
});

test("a native host that rejects this extension requests an installer repair", async () => {
  const storageWrites = [];
  const runtime = {
    lastError: null,
    sendNativeMessage(_host, _request, callback) {
      this.lastError = {
        message: "Access to the specified native messaging host is forbidden.",
      };
      callback(undefined);
      this.lastError = null;
    },
  };
  const client = createNativeRuntimeClient({
    runtime,
    storage: {
      async set(value) {
        storageWrites.push(structuredClone(value));
      },
    },
    productVersion: "0.7.9",
    runtimeRevision: "source-adapters-v87",
    now: () => FIXED_NOW,
    randomUUID: () => FIXED_REQUEST_ID,
  });

  const outcome = await client.status({ trigger: "setup_check" });

  assert.deepEqual(outcome, {
    schemaVersion: 1,
    state: "runtime_failed",
    trigger: "setup_check",
    observedAt: "2026-07-28T10:00:00.000Z",
    errorCode: "native_host_forbidden",
    retryable: false,
    remediation: "reinstall_runtime",
  });
  assert.deepEqual(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], outcome);
});

test("native host statuses map to explicit client states", async () => {
  const cases = [
    ["updating", "runtime_updating"],
    ["busy", "runtime_busy"],
    ["restart_required", "runtime_restart_required"],
    ["incompatible", "runtime_incompatible"],
  ];

  for (const [status, expectedState] of cases) {
    const { client } = clientWithResponder((_host, request, callback) => {
      callback(readyResponse(request, { status }));
    });
    const outcome = await client.status();
    assert.equal(outcome.state, expectedState);
  }
});

test("successful idle shutdown maps ready-stopped to an explicit stopped state", async () => {
  const { client } = clientWithResponder((_host, request, callback) => {
    const response = readyResponse(request);
    response.runtime.processState = "stopped";
    response.runtime.instanceEpoch = "shutdown-complete";
    callback(response);
  });

  const outcome = await client.shutdownIfIdle({ trigger: "setup_stop" });

  assert.equal(outcome.state, NATIVE_RUNTIME_CLIENT_STATES.STOPPED);
  assert.equal(outcome.response.runtime.processState, "stopped");
});

test("Codex checks use a bounded action and separate persisted state", async () => {
  let observedRequest;
  const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
    observedRequest = request;
    callback(codexResponse(request, "available"));
  });

  const outcome = await client.checkCodex({ trigger: "setup_codex_check" });

  assert.equal(observedRequest.action, "check_codex");
  assert.equal(outcome.state, NATIVE_RUNTIME_CLIENT_STATES.CODEX_AVAILABLE);
  assert.equal(outcome.response.codex.status, "available");
  assert.equal(Object.hasOwn(storageWrites.at(-1), NATIVE_CODEX_STATE_KEY), true);
  assert.equal(Object.hasOwn(storageWrites.at(-1), NATIVE_RUNTIME_STATE_KEY), false);
});

test("missing Codex maps to installation guidance without exposing paths", async () => {
  const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
    callback(codexResponse(request, "not_found"));
  });

  const outcome = await client.checkCodex();

  assert.equal(outcome.state, NATIVE_RUNTIME_CLIENT_STATES.CODEX_NOT_FOUND);
  assert.equal(outcome.errorCode, "codex_not_found");
  assert.equal(outcome.remediation, "install_codex");
  assert.equal(JSON.stringify(outcome).includes("executable"), false);
  assert.equal(storageWrites.at(-1)[NATIVE_CODEX_STATE_KEY].state, "codex_not_found");
});

test("schema-valid incompatible details remain typed but are not persisted verbatim", async () => {
  const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
    callback(readyResponse(request, {
      status: "incompatible",
      runtime: null,
      error: {
        code: "runtime_incompatible",
        message: "Installed runtime cannot serve the requested revision.",
        retryable: false,
        remediation: "reinstall_runtime",
      },
    }));
  });

  const outcome = await client.ensureRuntime();

  assert.equal(outcome.state, "runtime_incompatible");
  assert.equal(outcome.errorCode, "runtime_incompatible");
  assert.equal(outcome.remediation, "reinstall_runtime");
  assert.equal("message" in storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], false);
});

test("malformed, mismatched, and extended native responses fail closed", async () => {
  const responseMutators = [
    (response) => ({ ...response, requestId: "different-request-1" }),
    (response) => ({ ...response, action: "status" }),
    (response) => ({ ...response, command: "powershell.exe" }),
    (response) => ({
      ...response,
      runtime: { ...response.runtime, executablePath: "C:\\untrusted\\runtime.exe" },
    }),
  ];

  for (const mutate of responseMutators) {
    const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
      callback(mutate(readyResponse(request)));
    });
    const outcome = await client.ensureRuntime();
    assert.equal(outcome.state, "runtime_failed");
    assert.equal(outcome.errorCode, "invalid_native_response");
    assert.equal("response" in outcome, false);
    assert.deepEqual(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY], outcome);
  }
});

test("arbitrary actions are rejected before native messaging or storage", async () => {
  let nativeCalls = 0;
  const { client, storageWrites } = clientWithResponder(() => {
    nativeCalls += 1;
  });

  await assert.rejects(
    () => client.request("execute_shell"),
    /Unsupported native runtime action/,
  );
  assert.equal(nativeCalls, 0);
  assert.equal(storageWrites.length, 0);
});

test("host error details are reduced to bounded state before storage", async () => {
  const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
    callback(readyResponse(request, {
      status: "error",
      runtime: null,
      error: {
        code: "runtime_start_failed",
        message: "Internal path and diagnostic details that must not be persisted.",
        retryable: true,
        remediation: "retry",
      },
    }));
  });

  const outcome = await client.ensureRuntime();

  assert.equal(outcome.state, "runtime_failed");
  assert.equal(outcome.errorCode, "runtime_start_failed");
  const persisted = storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY];
  assert.equal(persisted.errorCode, "runtime_start_failed");
  assert.equal("message" in persisted, false);
  assert.equal("runtime" in persisted, false);
});

test("staging, candidate, and rollback failures remain visibly typed", async () => {
  const cases = [
    ["checksum_invalid", "reinstall_runtime", false],
    ["candidate_health_failed", "retry", true],
    ["rollback_failed", "contact_support", false],
  ];
  for (const [code, remediation, retryable] of cases) {
    const { client, storageWrites } = clientWithResponder((_host, request, callback) => {
      callback(readyResponse(request, {
        status: "error",
        runtime: null,
        update: {
          phase: code === "rollback_failed" ? "rolling_back" : "health_check",
          currentVersion: "0.7.4",
          targetVersion: "0.7.9",
          rollbackAvailable: true,
        },
        error: {
          code,
          message: "Bounded lifecycle failure.",
          retryable,
          remediation,
        },
      }));
    });
    const outcome = await client.ensureRuntime({ trigger: "lifecycle_acceptance" });
    assert.equal(outcome.state, "runtime_failed");
    assert.equal(outcome.errorCode, code);
    assert.equal(outcome.remediation, remediation);
    assert.equal(outcome.retryable, retryable);
    assert.equal(storageWrites.at(-1)[NATIVE_RUNTIME_STATE_KEY].errorCode, code);
  }
});

test("portable fallback probes only the fixed loopback health contract", async () => {
  let requestedUrl;
  const ready = await probeCompatibleLoopbackRuntime({
    productVersion: "0.7.4",
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.cache, "no-store");
      return {
        ok: true,
        async json() {
          return {
            status: "ok",
            version: "0.7.4",
            runtime: "go",
            bridgeContractVersion: "aku-browser.bridge.v2",
            instanceEpoch: "runtime:0001",
          };
        },
      };
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:11122/api/health");
  assert.equal(ready, true);
  assert.equal(await probeCompatibleLoopbackRuntime({
    productVersion: "0.7.4",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          status: "ok",
          version: "9.9.9",
          runtime: "go",
          bridgeContractVersion: "aku-browser.bridge.v2",
          instanceEpoch: "runtime:0001",
        };
      },
    }),
  }), false);
});

function clientWithResponder(responder) {
  const storageWrites = [];
  const runtime = {
    lastError: undefined,
    sendNativeMessage(host, request, callback) {
      responder(host, request, callback);
    },
  };
  const storage = {
    async set(value) {
      storageWrites.push(structuredClone(value));
    },
  };
  const client = createNativeRuntimeClient({
    runtime,
    storage,
    productVersion: "0.7.4",
    now: () => FIXED_NOW,
    randomUUID: () => FIXED_REQUEST_ID,
  });
  return { client, runtime, storageWrites };
}

function readyResponse(request, overrides = {}) {
  const status = overrides.status ?? "ready";
  return {
    schemaVersion: 1,
    kind: "response",
    requestId: request.requestId,
    action: request.action,
    status,
    runtime: {
      version: "0.7.4",
      channel: "stable",
      runtimeRevision: "source-adapters-v87",
      bridgeContractVersion: "aku-browser.bridge.v2",
      endpoint: "http://127.0.0.1:11122",
      instanceEpoch: "runtime:0001",
      processState: status === "ready" ? "ready" : "starting",
    },
    update: {
      phase: status === "updating" ? "downloading" : "idle",
      currentVersion: "0.7.4",
      targetVersion: status === "updating" ? "0.7.9" : null,
      rollbackAvailable: true,
    },
    error: null,
    ...overrides,
  };
}

function codexResponse(request, status) {
  const available = status === "available";
  return {
    schemaVersion: 1,
    kind: "response",
    requestId: request.requestId,
    action: request.action,
    status: available ? "ready" : "error",
    runtime: null,
    update: {
      phase: "idle",
      currentVersion: null,
      targetVersion: null,
      rollbackAvailable: false,
    },
    error: available ? null : {
      code: "codex_not_found",
      message: "A compatible Codex App Server installation was not found.",
      retryable: false,
      remediation: "install_codex",
    },
    codex: { status },
  };
}
