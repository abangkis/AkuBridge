import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_PROTOCOL_MAJOR,
  BRIDGE_RUNTIME_REVISION,
  createBridgeCapabilities,
} from "./bridge-capabilities.js";

export const NATIVE_RUNTIME_HOST = "com.akubrowser.runtime";
export const NATIVE_RUNTIME_PROTOCOL_VERSION = 2;
export const NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION = 1;
export const NATIVE_RUNTIME_STATE_KEY = "akuBrowserNativeRuntimeState";
export const NATIVE_CODEX_STATE_KEY = "akuBrowserNativeCodexState";
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
  CODEX_CHECKING: "codex_checking",
  CODEX_AVAILABLE: "codex_available",
  CODEX_NOT_FOUND: "codex_not_found",
  CODEX_FAILED: "codex_check_failed",
});

const ALLOWED_ACTIONS = new Set([
  "status",
  "ensure_runtime",
  "reconcile_runtime",
  "shutdown_if_idle",
  "check_codex",
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
  "staged",
  "waiting_for_idle",
  "applying",
  "swapping",
  "health_check",
  "validating",
  "complete",
  "rolling_back",
  "rolled_back",
]);
const ERROR_CODES = new Set([
  "invalid_request",
  "unauthorized_extension",
  "protocol_incompatible",
  "runtime_incompatible",
  "host_upgrade_required",
  "runtime_busy",
  "runtime_start_failed",
  "data_version_incompatible",
  "update_check_failed",
  "download_failed",
  "signature_invalid",
  "checksum_invalid",
  "candidate_health_failed",
  "rollback_failed",
  "internal_error",
  "codex_not_found",
  "codex_check_failed",
]);
const REMEDIATIONS = new Set([
  "retry",
  "wait",
  "restart_chrome",
  "reinstall_runtime",
  "reset_data",
  "contact_support",
  "none",
  "install_codex",
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
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{1,79}$/;
const DEFAULT_NATIVE_CAPABILITIES = Object.freeze([
  ...ALLOWED_ACTIONS,
  "authority.read_only_bounded",
  "capture.bounded",
]);

export function createNativeRuntimeClient({
  runtime,
  storage,
  productVersion,
  runtimeRevision = BRIDGE_RUNTIME_REVISION,
  bridgeContractVersion = BRIDGE_CONTRACT_VERSION,
  capabilities = DEFAULT_NATIVE_CAPABILITIES,
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
  const nativeCapabilities = normalizeCapabilities(capabilities);

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

    const stateKey = action === "check_codex"
      ? NATIVE_CODEX_STATE_KEY
      : NATIVE_RUNTIME_STATE_KEY;
    await persistState(storage, stateKey, {
      schemaVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
      state: action === "check_codex"
        ? NATIVE_RUNTIME_CLIENT_STATES.CODEX_CHECKING
        : NATIVE_RUNTIME_CLIENT_STATES.CHECKING_HOST,
      trigger: normalizeTrigger(trigger),
      observedAt: new Date(now()).toISOString(),
    });

    let exchange = await exchangeNativeMessage({
      runtime,
      hostName,
      action,
      productVersion,
      runtimeRevision,
      bridgeContractVersion,
      capabilities: nativeCapabilities,
      protocolVersion: NATIVE_RUNTIME_PROTOCOL_VERSION,
      randomUUID,
      timeoutMs,
    });
    if (shouldRetryWithLegacyProtocol(exchange)) {
      const legacyAction = action === "reconcile_runtime" ? "status" : action;
      exchange = await exchangeNativeMessage({
        runtime,
        hostName,
        action: legacyAction,
        productVersion,
        runtimeRevision,
        bridgeContractVersion,
        capabilities: nativeCapabilities,
        protocolVersion: NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION,
        randomUUID,
        timeoutMs,
      });
      if (action === "reconcile_runtime" && legacyStatusNeedsStart(exchange)) {
        exchange = await exchangeNativeMessage({
          runtime,
          hostName,
          action: "ensure_runtime",
          productVersion,
          runtimeRevision,
          bridgeContractVersion,
          capabilities: nativeCapabilities,
          protocolVersion: NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION,
          randomUUID,
          timeoutMs,
        });
      }
    }
    if (exchange.error) {
      const error = exchange.error;
      const missingHost = isMissingNativeHostError(error);
      const forbiddenHost = isForbiddenNativeHostError(error);
      const outcome = {
        schemaVersion: exchange.protocolVersion,
        state: missingHost
          ? NATIVE_RUNTIME_CLIENT_STATES.INSTALL_REQUIRED
          : NATIVE_RUNTIME_CLIENT_STATES.FAILED,
        trigger: normalizeTrigger(trigger),
        observedAt: new Date(now()).toISOString(),
        errorCode: missingHost
          ? "native_host_not_found"
          : forbiddenHost
            ? "native_host_forbidden"
            : "native_message_failed",
        retryable: !missingHost && !forbiddenHost,
        remediation: missingHost
          ? "install_runtime"
          : forbiddenHost
            ? "reinstall_runtime"
            : "retry",
      };
      await persistState(storage, stateKey, outcome);
      return outcome;
    }

    const { response, request: nativeRequest } = exchange;
    try {
      assertValidResponse(response, nativeRequest);
    } catch {
      const outcome = {
        schemaVersion: exchange.protocolVersion,
        state: NATIVE_RUNTIME_CLIENT_STATES.FAILED,
        trigger: normalizeTrigger(trigger),
        observedAt: new Date(now()).toISOString(),
        errorCode: "invalid_native_response",
        retryable: false,
        remediation: "reinstall_runtime",
      };
      await persistState(storage, stateKey, outcome);
      return outcome;
    }

    const outcome = stateFromResponse(response, trigger, now);
    await persistState(storage, stateKey, outcome);
    return { ...outcome, response };
  }

  return Object.freeze({
    request,
    status: (options) => request("status", options),
    ensureRuntime: (options) => request("ensure_runtime", options),
    reconcileRuntime: (options) => request("reconcile_runtime", options),
    shutdownIfIdle: (options) => request("shutdown_if_idle", options),
    checkCodex: (options) => request("check_codex", options),
  });
}

export function createChromeNativeRuntimeClient(chromeApi) {
  const manifest = chromeApi.runtime.getManifest();
  const bridge = createBridgeCapabilities(manifest);
  return createNativeRuntimeClient({
    runtime: chromeApi.runtime,
    storage: chromeApi.storage?.local,
    productVersion: manifest.version_name || manifest.version,
    capabilities: [
      ...bridge.actions,
      `authority.${bridge.authority}`,
      "capture.bounded",
    ],
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
    if (health?.status !== "ok"
        || !VERSION_PATTERN.test(health.version ?? "")
        || health.runtime !== "go"
        || health.bridgeContractVersion !== bridgeContractVersion
        || typeof health.instanceEpoch !== "string"
        || health.instanceEpoch.length < 8) {
      return false;
    }
    const protocol = health.softwareUpdate?.bridgeProtocol;
    if (protocol?.name === "aku-browser.bridge"
        && Number.isInteger(protocol.minVersion)
        && Number.isInteger(protocol.maxVersion)) {
      return BRIDGE_PROTOCOL_MAJOR >= protocol.minVersion
        && BRIDGE_PROTOCOL_MAJOR <= protocol.maxVersion;
    }
    // Old Sidecars advertised no compatibility range and remain safe only
    // under the exact release tuple they were built to serve.
    return health.version === productVersion;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function assertValidResponse(response, request) {
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "requestId",
    "action",
    "status",
    "runtime",
    "update",
    "error",
  ];
  if (request.action === "check_codex") expectedKeys.push("codex");
  assertExactKeys(response, expectedKeys, "response");
  if (response.schemaVersion !== request.schemaVersion) {
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
  assertUpdateState(response.update, response.schemaVersion);
  assertErrorState(response.error);
  if (request.action === "check_codex") assertCodexState(response.codex);
  return true;
}

function stateFromResponse(response, trigger, now) {
  if (response.action === "check_codex") {
    const codexState = response.codex?.status === "available"
      ? NATIVE_RUNTIME_CLIENT_STATES.CODEX_AVAILABLE
      : response.codex?.status === "not_found"
        ? NATIVE_RUNTIME_CLIENT_STATES.CODEX_NOT_FOUND
        : NATIVE_RUNTIME_CLIENT_STATES.CODEX_FAILED;
    const outcome = {
      schemaVersion: response.schemaVersion,
      state: codexState,
      trigger: normalizeTrigger(trigger),
      observedAt: new Date(now()).toISOString(),
      status: response.status,
      retryable: response.error?.retryable ?? false,
      remediation: response.error?.remediation ?? "none",
    };
    if (response.error) outcome.errorCode = response.error.code;
    return outcome;
  }
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
    schemaVersion: response.schemaVersion,
    state,
    trigger: normalizeTrigger(trigger),
    observedAt: new Date(now()).toISOString(),
    status: response.status,
    retryable: response.error?.retryable ?? ["updating", "busy"].includes(response.status),
    remediation: response.error?.remediation
      ?? (response.status === "restart_required" ? "restart_chrome" : "none"),
    update: normalizedUpdateState(response.update),
  };
  if (response.error) {
    outcome.errorCode = response.error.code;
    outcome.silentError = response.status === "ready"
      && response.runtime?.processState === "ready"
      && ["runtime_busy", "update_check_failed", "download_failed"]
        .includes(response.error.code);
    if (response.error.code === "host_upgrade_required") {
      outcome.hostUpgradeRequired = true;
    }
  }
  if (response.schemaVersion === NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION) {
    // A v1 host can keep the current Sidecar usable, but it cannot participate
    // in independently-versioned Sidecar updates. Surface one bounded repair
    // path instead of silently leaving the machine on the migration lane.
    outcome.hostUpgradeRequired = true;
  }
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

function assertUpdateState(updateState, protocolVersion) {
  const optionalKeys = protocolVersion === NATIVE_RUNTIME_PROTOCOL_VERSION
    ? ["urgency", "deadline"]
    : [];
  assertAllowedKeys(updateState, [
    "phase",
    "currentVersion",
    "targetVersion",
    "rollbackAvailable",
  ], optionalKeys, "update");
  if (!UPDATE_PHASES.has(updateState.phase)) throw new TypeError("Update phase is invalid.");
  for (const version of [updateState.currentVersion, updateState.targetVersion]) {
    if (version !== null && !VERSION_PATTERN.test(version ?? "")) {
      throw new TypeError("Update version is invalid.");
    }
  }
  if (typeof updateState.rollbackAvailable !== "boolean") {
    throw new TypeError("Update rollback flag is invalid.");
  }
  if (updateState.urgency !== undefined
      && !["routine", "recommended", "required", "security"].includes(updateState.urgency)) {
    throw new TypeError("Update urgency is invalid.");
  }
  if (updateState.deadline !== undefined
      && (!Number.isFinite(Date.parse(updateState.deadline))
        || !["required", "security"].includes(updateState.urgency))) {
    throw new TypeError("Update deadline is invalid.");
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

function assertAllowedKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Native ${label} must be an object.`);
  }
  const actual = new Set(Object.keys(value));
  for (const key of required) {
    if (!actual.has(key)) {
      throw new TypeError(`Native ${label} contains missing or unexpected fields.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  if ([...actual].some((key) => !allowed.has(key))) {
    throw new TypeError(`Native ${label} contains missing or unexpected fields.`);
  }
}

async function exchangeNativeMessage({
  runtime,
  hostName,
  action,
  productVersion,
  runtimeRevision,
  bridgeContractVersion,
  capabilities,
  protocolVersion,
  randomUUID,
  timeoutMs,
}) {
  const extension = {
    product: "AkuBrowser",
    productVersion,
    runtimeRevision,
    bridgeContractVersion,
  };
  if (protocolVersion === NATIVE_RUNTIME_PROTOCOL_VERSION) {
    extension.bridgeProtocol = {
      name: "aku-browser.bridge",
      version: BRIDGE_PROTOCOL_MAJOR,
    };
    extension.capabilities = [...capabilities];
  }
  const request = {
    schemaVersion: protocolVersion,
    kind: "request",
    requestId: normalizeRequestId(randomUUID()),
    action,
    extension,
  };
  try {
    const response = await sendNativeMessage(runtime, hostName, request, timeoutMs);
    return { protocolVersion, request, response, error: null };
  } catch (error) {
    return { protocolVersion, request, response: null, error };
  }
}

function shouldRetryWithLegacyProtocol(exchange) {
  if (exchange.protocolVersion !== NATIVE_RUNTIME_PROTOCOL_VERSION) return false;
  if (exchange.error) return isLikelyLegacyProtocolTransportError(exchange.error);
  const response = exchange.response;
  return response?.schemaVersion === NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION
    && response?.requestId === exchange.request.requestId
    && response?.action === exchange.request.action
    && ["protocol_incompatible", "invalid_request"].includes(response?.error?.code);
}

function legacyStatusNeedsStart(exchange) {
  if (exchange.error || exchange.protocolVersion !== NATIVE_RUNTIME_LEGACY_PROTOCOL_VERSION) {
    return false;
  }
  try {
    assertValidResponse(exchange.response, exchange.request);
  } catch {
    return false;
  }
  const response = exchange.response;
  return response.action === "status"
    && response.runtime?.processState === "stopped"
    && (response.status === "ready"
      || (response.status === "error"
        && response.error?.code === "runtime_start_failed"
        && response.error.retryable === true));
}

function isLikelyLegacyProtocolTransportError(error) {
  if (isMissingNativeHostError(error) || isForbiddenNativeHostError(error)) return false;
  return /native host has exited|native messaging host.*exited|message port closed|disconnected.*response|no response/i
    .test(String(error?.message ?? error));
}

function normalizeCapabilities(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("Native runtime capabilities must be an array.");
  }
  const normalized = [...new Set(values.map((value) => String(value ?? "").trim()))].sort();
  if (normalized.length < 1 || normalized.length > 64
      || normalized.some((value) => !CAPABILITY_PATTERN.test(value))) {
    throw new TypeError("Native runtime capabilities are invalid.");
  }
  return Object.freeze(normalized);
}

function normalizedUpdateState(value) {
  const normalized = {
    phase: value.phase,
    currentVersion: value.currentVersion,
    targetVersion: value.targetVersion,
    rollbackAvailable: value.rollbackAvailable,
  };
  if (value.urgency !== undefined) normalized.urgency = value.urgency;
  if (value.deadline !== undefined) normalized.deadline = value.deadline;
  return Object.freeze(normalized);
}

function assertCodexState(codexState) {
  assertExactKeys(codexState, ["status"], "codex");
  if (!["available", "not_found", "error"].includes(codexState.status)) {
    throw new TypeError("Native Codex status is invalid.");
  }
}

function isMissingNativeHostError(error) {
  return /native messaging host.*not found|specified native messaging host not found/i
    .test(String(error?.message ?? error));
}

function isForbiddenNativeHostError(error) {
  return /access to the specified native messaging host is forbidden|native messaging host.*forbidden/i
    .test(String(error?.message ?? error));
}

async function persistState(storage, key, state) {
  if (!storage?.set) return;
  await storage.set({ [key]: state });
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
