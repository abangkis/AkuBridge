import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_RUNTIME_REVISION,
} from "./bridge-capabilities.js";

export const NATIVE_RUNTIME_HOST = "com.akubrowser.runtime";
export const NATIVE_RUNTIME_PROTOCOL_VERSION = 1;
export const NATIVE_RUNTIME_STATE_KEY = "akuBrowserNativeRuntimeState";
export const AKU_BROWSER_LOOPBACK_ORIGIN = "http://127.0.0.1:11122";

export const NATIVE_RUNTIME_CLIENT_STATES = Object.freeze({
  CHECKING_HOST: "checking_host",
  INSTALL_REQUIRED: "runtime_install_required",
  READY: "runtime_ready",
  STOPPED: "runtime_stopped",
  UPDATING: "runtime_updating",
  BUSY: "runtime_busy",
  RESTART_REQUIRED: "runtime_restart_required",
  INCOMPATIBLE: "runtime_incompatible",
  FAILED: "runtime_failed",
});

const ALLOWED_ACTIONS = new Set([
  "status",
  "ensure_runtime",
  "shutdown_if_idle",
]);
const RESPONSE_STATUSES = new Set([
  "ready",
  "updating",
  "restart_required",
  "busy",
  "incompatible",
  "error",
]);
const PROCESS_STATES = new Set([
  "stopped",
  "starting",
  "ready",
  "stopping",
  "failed",
]);
const UPDATE_PHASES = new Set([
  "idle",
  "checking",
  "downloading",
  "verifying",
  "staging",
  "waiting_for_idle",
  "swapping",
  "health_check",
  "rolling_back",
]);
const ERROR_CODES = new Set([
  "invalid_request",
  "unauthorized_extension",
  "protocol_incompatible",
  "runtime_incompatible",
  "runtime_busy",
  "runtime_start_failed",
  "update_check_failed",
  "download_failed",
  "signature_invalid",
  "checksum_invalid",
  "candidate_health_failed",
  "rollback_failed",
  "internal_error",
]);
const REMEDIATIONS = new Set([
  "retry",
  "wait",
  "restart_chrome",
  "reinstall_runtime",
  "contact_support",
  "none",
]);
const ENDPOINTS = new Set([
  "http://127.0.0.1:11122",
  "http://localhost:11122",
]);
const CHANNELS = new Set(["stable", "preview"]);
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{16,80}$/;
const INSTANCE_EPOCH_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function createNativeRuntimeClient({
  runtime,
  storage,
  productVersion,
  runtimeRevision = BRIDGE_RUNTIME_REVISION,
  bridgeContractVersion = BRIDGE_CONTRACT_VERSION,
  hostName = NATIVE_RUNTIME_HOST,
  now = () => Date.now(),
  randomUUID = defaultRandomUUID,
  nativeMessageTimeoutMs = 30_000,
} = {}) {
  if (!runtime?.sendNativeMessage) {
    throw new TypeError("Native runtime client requires runtime.sendNativeMessage.");
  }
  if (!VERSION_PATTERN.test(productVersion ?? "")) {
    throw new TypeError("Native runtime client requires a semantic productVersion.");
  }
  if (!REVISION_PATTERN.test(runtimeRevision ?? "")) {
    throw new TypeError("Native runtime client requires a valid runtimeRevision.");
  }
  if (bridgeContractVersion !== BRIDGE_CONTRACT_VERSION) {
    throw new TypeError("Native runtime client received an unsupported bridge contract.");
  }

  async function request(action, {
    trigger = "manual",
    timeoutMs = nativeMessageTimeoutMs,
  } = {}) {
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new TypeError(`Unsupported native runtime action: ${String(action)}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("Native runtime request timeout must be positive.");
    }

    const requestId = normalizeRequestId(randomUUID());
    const nativeRequest = {
      schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      action,
      extension: {
        product: "AkuBrowser",
        productVersion,
        runtimeRevision,
        bridgeContractVersion,
      },
    };
    await persistState(storage, {
      schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
      state: NATIVE_RUNTIME_CLIENT_STATES.CHECKING_HOST,
      trigger: normalizeTrigger(trigger),
      observedAt: new Date(now()).toISOString(),
    });

    let response;
    try {
      response = await sendNativeMessage(runtime, hostName, nativeRequest, timeoutMs);
    } catch (error) {
      const missingHost = isMissingNativeHostError(error);
      const outcome = {
        schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
        state: missingHost
          ? NATIVE_RUNTIME_CLIENT_STATES.INSTALL_REQUIRED
          : NATIVE_RUNTIME_CLIENT_STATES.FAILED,
        trigger: normalizeTrigger(trigger),
        observedAt: new Date(now()).toISOString(),
        errorCode: missingHost ? "native_host_not_found" : "native_message_failed",
        retryable: !missingHost,
        remediation: missingHost ? "install_runtime" : "retry",
      };
      await persistState(storage, outcome);
      return outcome;
    }

    try {
      assertValidResponse(response, nativeRequest);
    } catch {
      const outcome = {
        schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
        state: NATIVE_RUNTIME_CLIENT_STATES.FAILED,
        trigger: normalizeTrigger(trigger),
        observedAt: new Date(now()).toISOString(),
        errorCode: "invalid_native_response",
        retryable: false,
        remediation: "reinstall_runtime",
      };
      await persistState(storage, outcome);
      return outcome;
    }

    const outcome = stateFromResponse(response, trigger, now);
    await persistState(storage, outcome);
    return { ...outcome, response };
  }

  return Object.freeze({
    request,
    status: (options) => request("status", options),
    ensureRuntime: (options) => request("ensure_runtime", options),
    shutdownIfIdle: (options) => request("shutdown_if_idle", options),
  });
}

export function createChromeNativeRuntimeClient(chromeApi) {
  const manifest = chromeApi.runtime.getManifest();
  return createNativeRuntimeClient({
    runtime: chromeApi.runtime,
    storage: chromeApi.storage?.local,
    productVersion: manifest.version_name || manifest.version,
  });
}

export async function probeCompatibleLoopbackRuntime({
  fetchImpl = globalThis.fetch,
  productVersion,
  bridgeContractVersion = BRIDGE_CONTRACT_VERSION,
  timeoutMs = 1_500,
} = {}) {
  if (typeof fetchImpl !== "function" || !VERSION_PATTERN.test(productVersion ?? "")) {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${AKU_BROWSER_LOOPBACK_ORIGIN}/api/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.status === "ok"
      && health.version === productVersion
      && health.runtime === "go"
      && health.bridgeContractVersion === bridgeContractVersion
      && typeof health.instanceEpoch === "string"
      && health.instanceEpoch.length >= 8;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function assertValidResponse(response, request) {
  assertExactKeys(response, [
    "schemaVersion",
    "kind",
    "requestId",
    "action",
    "status",
    "runtime",
    "update",
    "error",
  ], "response");
  if (response.schemaVersion !== NATIVE_RUNTIME_PROTOCOL_VERSION) {
    throw new TypeError("Native response protocol version is incompatible.");
  }
  if (response.kind !== "response") throw new TypeError("Native response kind is invalid.");
  if (!REQUEST_ID_PATTERN.test(response.requestId ?? "") || response.requestId !== request.requestId) {
    throw new TypeError("Native response requestId does not match.");
  }
  if (!ALLOWED_ACTIONS.has(response.action) || response.action !== request.action) {
    throw new TypeError("Native response action does not match.");
  }
  if (!RESPONSE_STATUSES.has(response.status)) {
    throw new TypeError("Native response status is invalid.");
  }
  assertRuntimeState(response.runtime);
  assertUpdateState(response.update);
  assertErrorState(response.error);
  return true;
}

function stateFromResponse(response, trigger, now) {
  const stateByStatus = {
    ready: NATIVE_RUNTIME_CLIENT_STATES.READY,
    updating: NATIVE_RUNTIME_CLIENT_STATES.UPDATING,
    busy: NATIVE_RUNTIME_CLIENT_STATES.BUSY,
    restart_required: NATIVE_RUNTIME_CLIENT_STATES.RESTART_REQUIRED,
    incompatible: NATIVE_RUNTIME_CLIENT_STATES.INCOMPATIBLE,
    error: NATIVE_RUNTIME_CLIENT_STATES.FAILED,
  };
  const state = response.status === "ready" && response.runtime?.processState === "stopped"
    ? NATIVE_RUNTIME_CLIENT_STATES.STOPPED
    : stateByStatus[response.status];
  const outcome = {
    schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
    state,
    trigger: normalizeTrigger(trigger),
    observedAt: new Date(now()).toISOString(),
    status: response.status,
    retryable: response.error?.retryable ?? ["updating", "busy"].includes(response.status),
    remediation: response.error?.remediation
      ?? (response.status === "restart_required" ? "restart_chrome" : "none"),
  };
  if (response.error) outcome.errorCode = response.error.code;
  return outcome;
}

function assertRuntimeState(runtimeState) {
  if (runtimeState === null) return;
  assertExactKeys(runtimeState, [
    "version",
    "channel",
    "runtimeRevision",
    "bridgeContractVersion",
    "endpoint",
    "instanceEpoch",
    "processState",
  ], "runtime");
  if (!VERSION_PATTERN.test(runtimeState.version ?? "")) throw new TypeError("Runtime version is invalid.");
  if (!CHANNELS.has(runtimeState.channel)) throw new TypeError("Runtime channel is invalid.");
  if (!REVISION_PATTERN.test(runtimeState.runtimeRevision ?? "")) {
    throw new TypeError("Runtime revision is invalid.");
  }
  if (runtimeState.bridgeContractVersion !== BRIDGE_CONTRACT_VERSION) {
    throw new TypeError("Runtime bridge contract is incompatible.");
  }
  if (!ENDPOINTS.has(runtimeState.endpoint)) throw new TypeError("Runtime endpoint is invalid.");
  if (!INSTANCE_EPOCH_PATTERN.test(runtimeState.instanceEpoch ?? "")) {
    throw new TypeError("Runtime instance epoch is invalid.");
  }
  if (!PROCESS_STATES.has(runtimeState.processState)) {
    throw new TypeError("Runtime process state is invalid.");
  }
}

function assertUpdateState(updateState) {
  assertExactKeys(updateState, [
    "phase",
    "currentVersion",
    "targetVersion",
    "rollbackAvailable",
  ], "update");
  if (!UPDATE_PHASES.has(updateState.phase)) throw new TypeError("Update phase is invalid.");
  for (const version of [updateState.currentVersion, updateState.targetVersion]) {
    if (version !== null && !VERSION_PATTERN.test(version ?? "")) {
      throw new TypeError("Update version is invalid.");
    }
  }
  if (typeof updateState.rollbackAvailable !== "boolean") {
    throw new TypeError("Update rollback flag is invalid.");
  }
}

function assertErrorState(errorState) {
  if (errorState === null) return;
  assertExactKeys(errorState, [
    "code",
    "message",
    "retryable",
    "remediation",
  ], "error");
  if (!ERROR_CODES.has(errorState.code)) throw new TypeError("Native error code is invalid.");
  if (typeof errorState.message !== "string"
      || errorState.message.length < 1
      || errorState.message.length > 300) {
    throw new TypeError("Native error message is invalid.");
  }
  if (typeof errorState.retryable !== "boolean") {
    throw new TypeError("Native retry flag is invalid.");
  }
  if (!REMEDIATIONS.has(errorState.remediation)) {
    throw new TypeError("Native remediation is invalid.");
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Native ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length
      || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`Native ${label} contains missing or unexpected fields.`);
  }
}

function sendNativeMessage(runtime, hostName, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      finish(reject, new Error("Native messaging timed out."));
    }, timeoutMs);
    try {
      runtime.sendNativeMessage(hostName, request, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          finish(reject, new Error(lastError.message || "Native messaging failed."));
          return;
        }
        finish(resolve, response);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function isMissingNativeHostError(error) {
  return /native messaging host.*not found|specified native messaging host not found/i
    .test(String(error?.message ?? error));
}

async function persistState(storage, state) {
  if (!storage?.set) return;
  await storage.set({ [NATIVE_RUNTIME_STATE_KEY]: state });
}

function normalizeTrigger(value) {
  const normalized = String(value ?? "manual")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 40);
  return normalized || "manual";
}

function normalizeRequestId(value) {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw new TypeError("Native requestId generator returned an invalid identifier.");
  }
  return normalized;
}

function defaultRandomUUID() {
  return globalThis.crypto.randomUUID();
}
