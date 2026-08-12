export const NATIVE_RUNTIME_CHECK_ALARM = "akuBridgeNativeRuntimeCheck";
export const NATIVE_RUNTIME_SCHEDULE_KEY = "akuBrowserNativeRuntimeSchedule";

const SCHEDULE_SCHEMA_VERSION = 1;
const MINIMUM_ALARM_DELAY_MS = 30_000;
const NORMAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const PENDING_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
const RETRY_BASE_INTERVAL_MS = 15 * 60 * 1_000;
const RETRY_MAX_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const JITTER_RATIO = 0.1;

export function createNativeRuntimeScheduler({
  alarms,
  storage,
  check,
  enabled = true,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  if (!alarms?.create || !alarms?.clear) {
    throw new TypeError("Native runtime scheduler requires the Chrome alarms API.");
  }
  if (!storage?.get || !storage?.set) {
    throw new TypeError("Native runtime scheduler requires local storage.");
  }
  if (typeof check !== "function") {
    throw new TypeError("Native runtime scheduler requires a runtime check function.");
  }

  let inFlight = null;
  let restoring = null;

  function restore() {
    if (restoring) return restoring;
    restoring = performRestore().finally(() => {
      restoring = null;
    });
    return restoring;
  }

  async function performRestore() {
    if (!enabled) {
      await alarms.clear(NATIVE_RUNTIME_CHECK_ALARM);
      return null;
    }
    const current = await readSchedule(storage);
    const currentTime = now();
    const scheduledAt = validFutureTimestamp(current?.nextCheckAt, currentTime)
      ?? (currentTime + (current
        ? MINIMUM_ALARM_DELAY_MS
        : nextRuntimeCheckDelay({
          outcome: { state: "runtime_ready", update: { phase: "idle" } },
          random,
        })));
    if (!current) {
      await storage.set({
        [NATIVE_RUNTIME_SCHEDULE_KEY]: {
          schemaVersion: SCHEDULE_SCHEMA_VERSION,
          failureCount: 0,
          lastCheckAt: null,
          nextCheckAt: new Date(scheduledAt).toISOString(),
          lastTrigger: "schedule_initialized",
        },
      });
    }
    await alarms.create(NATIVE_RUNTIME_CHECK_ALARM, { when: scheduledAt });
    return scheduledAt;
  }

  async function checkNow(trigger = "scheduled") {
    if (!enabled) return null;
    if (restoring) await restoring;
    if (inFlight) return inFlight;
    inFlight = performCheck(normalizeTrigger(trigger));
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function scheduleInitial() {
    return restore();
  }

  async function performCheck(trigger) {
    const previous = await readSchedule(storage);
    let outcome;
    try {
      outcome = await check(trigger);
    } catch {
      outcome = {
        state: "runtime_failed",
        retryable: true,
        errorCode: "runtime_check_failed",
      };
    }
    const failureCount = retryableFailure(outcome)
      ? Math.min(8, normalizedFailureCount(previous) + 1)
      : 0;
    const checkedAt = now();
    const delayMs = nextRuntimeCheckDelay({ outcome, failureCount, random });
    const nextCheckAt = checkedAt + delayMs;
    const schedule = {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      failureCount,
      lastCheckAt: new Date(checkedAt).toISOString(),
      nextCheckAt: new Date(nextCheckAt).toISOString(),
      lastTrigger: trigger,
    };
    await storage.set({ [NATIVE_RUNTIME_SCHEDULE_KEY]: schedule });
    await alarms.create(NATIVE_RUNTIME_CHECK_ALARM, { when: nextCheckAt });
    return outcome;
  }

  return Object.freeze({ restore, checkNow, scheduleInitial });
}

export function nextRuntimeCheckDelay({ outcome, failureCount = 0, random = Math.random } = {}) {
  let base = NORMAL_CHECK_INTERVAL_MS;
  if (retryableFailure(outcome)) {
    const exponent = Math.max(0, Math.min(7, Math.trunc(failureCount) - 1));
    base = Math.min(RETRY_MAX_INTERVAL_MS, RETRY_BASE_INTERVAL_MS * (2 ** exponent));
  } else if (runtimeUpdatePending(outcome)) {
    base = PENDING_CHECK_INTERVAL_MS;
  }
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = (sample * 2 - 1) * base * JITTER_RATIO;
  return Math.max(MINIMUM_ALARM_DELAY_MS, Math.round(base + jitter));
}

async function readSchedule(storage) {
  const stored = await storage.get(NATIVE_RUNTIME_SCHEDULE_KEY);
  const value = stored?.[NATIVE_RUNTIME_SCHEDULE_KEY];
  return value?.schemaVersion === SCHEDULE_SCHEMA_VERSION ? value : null;
}

function validFutureTimestamp(value, currentTime) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp > currentTime ? timestamp : null;
}

function normalizedFailureCount(value) {
  const count = Number(value?.failureCount);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function retryableFailure(outcome) {
  return outcome?.retryable === true && (
    outcome?.state === "runtime_failed"
      || ["update_check_failed", "download_failed", "native_message_failed"]
        .includes(outcome?.errorCode)
  );
}

function runtimeUpdatePending(outcome) {
  if (outcome?.errorCode && outcome?.retryable !== true) return false;
  return ["runtime_updating", "runtime_busy"].includes(outcome?.state)
    || [
      "checking",
      "downloading",
      "verifying",
      "staging",
      "staged",
      "waiting_for_idle",
      "swapping",
      "health_check",
      "validating",
      "rolling_back",
    ].includes(outcome?.update?.phase);
}

function normalizeTrigger(value) {
  const trigger = String(value ?? "scheduled")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 40);
  return trigger || "scheduled";
}
