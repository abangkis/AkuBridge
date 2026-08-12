export const NATIVE_RUNTIME_CHECK_ALARM = "akuBridgeNativeRuntimeCheck";
export const NATIVE_RUNTIME_SCHEDULE_KEY = "akuBrowserNativeRuntimeSchedule";

const SCHEDULE_SCHEMA_VERSION = 2;
const MINIMUM_ALARM_DELAY_MS = 30_000;
const NORMAL_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
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
    const stored = await readStoredSchedule(storage);
    const currentTime = now();
    const current = normalizeSchedule(stored, currentTime);
    const scheduledAt = validFutureTimestamp(current?.nextCheckAt, currentTime)
      ?? (current ? currentTime + MINIMUM_ALARM_DELAY_MS : currentTime + NORMAL_CHECK_INTERVAL_MS);
    if (!current || current.schemaVersion !== stored?.schemaVersion || scheduledAt !== Date.parse(current.nextCheckAt)) {
      const anchorAt = current?.anchorAt ?? new Date(currentTime).toISOString();
      await storage.set({
        [NATIVE_RUNTIME_SCHEDULE_KEY]: {
          schemaVersion: SCHEDULE_SCHEMA_VERSION,
          anchorAt,
          failureCount: normalizedFailureCount(current),
          lastCheckAt: current?.lastCheckAt ?? null,
          nextCheckAt: new Date(scheduledAt).toISOString(),
          lastTrigger: current?.lastTrigger ?? "schedule_initialized",
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
    const checkedAt = now();
    const previous = normalizeSchedule(await readStoredSchedule(storage), checkedAt);
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
    const delayMs = nextRuntimeCheckDelay({ outcome, failureCount, random });
    const anchorAt = Date.parse(previous?.anchorAt ?? "") || checkedAt;
    const nextCheckAt = retryableFailure(outcome) || runtimeUpdatePending(outcome)
      ? checkedAt + delayMs
      : nextAnchoredCheckAt(anchorAt, checkedAt);
    const schedule = {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      anchorAt: new Date(anchorAt).toISOString(),
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
  let jittered = false;
  if (retryableFailure(outcome)) {
    const exponent = Math.max(0, Math.min(7, Math.trunc(failureCount) - 1));
    base = Math.min(RETRY_MAX_INTERVAL_MS, RETRY_BASE_INTERVAL_MS * (2 ** exponent));
    jittered = true;
  } else if (runtimeUpdatePending(outcome)) {
    base = PENDING_CHECK_INTERVAL_MS;
    jittered = true;
  }
  if (!jittered) return base;
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitter = (sample * 2 - 1) * base * JITTER_RATIO;
  return Math.max(MINIMUM_ALARM_DELAY_MS, Math.round(base + jitter));
}

async function readStoredSchedule(storage) {
  const stored = await storage.get(NATIVE_RUNTIME_SCHEDULE_KEY);
  return stored?.[NATIVE_RUNTIME_SCHEDULE_KEY] ?? null;
}

function normalizeSchedule(value, currentTime) {
  if (value?.schemaVersion === SCHEDULE_SCHEMA_VERSION) {
    const anchorAt = Date.parse(value.anchorAt ?? "");
    if (Number.isFinite(anchorAt)) return value;
  }
  if (value?.schemaVersion === 1) {
    const nextCheckAt = Date.parse(value.nextCheckAt ?? "");
    const anchorAt = Number.isFinite(nextCheckAt) ? nextCheckAt : currentTime;
    return {
      ...value,
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      anchorAt: new Date(anchorAt).toISOString(),
      nextCheckAt: new Date(Number.isFinite(nextCheckAt) ? nextCheckAt : currentTime + NORMAL_CHECK_INTERVAL_MS).toISOString(),
    };
  }
  return null;
}

function nextAnchoredCheckAt(anchorAt, currentTime) {
  const elapsedIntervals = Math.floor((currentTime - anchorAt) / NORMAL_CHECK_INTERVAL_MS) + 1;
  return anchorAt + Math.max(1, elapsedIntervals) * NORMAL_CHECK_INTERVAL_MS;
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
