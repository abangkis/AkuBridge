import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_RUNTIME_CHECK_ALARM,
  NATIVE_RUNTIME_SCHEDULE_KEY,
  createNativeRuntimeScheduler,
  nextRuntimeCheckDelay,
} from "../native-runtime-scheduler.js";

const NOW = Date.parse("2026-08-12T05:00:00.000Z");

test("runtime scheduler migrates one persisted future alarm without bunching users", async () => {
  const future = new Date(NOW + 60_000).toISOString();
  const { alarms, created } = alarmRecorder();
  let checks = 0;
  const storage = memoryStorage({
    [NATIVE_RUNTIME_SCHEDULE_KEY]: { schemaVersion: 1, nextCheckAt: future },
  });
  const scheduler = createNativeRuntimeScheduler({
    alarms,
    storage,
    check: async () => {
      checks += 1;
      return { state: "runtime_ready" };
    },
    now: () => NOW,
  });

  assert.equal(await scheduler.restore(), NOW + 60_000);
  assert.deepEqual(created, [{ name: NATIVE_RUNTIME_CHECK_ALARM, when: NOW + 60_000 }]);
  assert.equal(checks, 0, "startup restore must not bypass the persisted update cadence");
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].schemaVersion, 2);
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].anchorAt, future);
});

test("successful scheduled check persists the next 24-hour installation anchor", async () => {
  const storage = memoryStorage();
  const { alarms, created } = alarmRecorder();
  const triggers = [];
  const scheduler = createNativeRuntimeScheduler({
    alarms,
    storage,
    check: async (trigger) => {
      triggers.push(trigger);
      return { state: "runtime_ready", update: { phase: "idle" } };
    },
    now: () => NOW,
    random: () => 0.5,
  });

  await scheduler.checkNow("scheduled alarm");

  assert.deepEqual(triggers, ["scheduled_alarm"]);
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].failureCount, 0);
  assert.equal(
    storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].nextCheckAt,
    new Date(NOW + (24 * 60 * 60 * 1_000)).toISOString(),
  );
  assert.equal(created.at(-1).when, NOW + (24 * 60 * 60 * 1_000));
  assert.equal(
    storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].anchorAt,
    new Date(NOW).toISOString(),
  );
});

test("runtime scheduler initializes missing state at the normal interval", async () => {
  const storage = memoryStorage();
  const { alarms, created } = alarmRecorder();
  const scheduler = createNativeRuntimeScheduler({
    alarms,
    storage,
    check: async () => ({ state: "runtime_ready" }),
    now: () => NOW,
    random: () => 0.5,
  });

  assert.equal(await scheduler.restore(), NOW + (24 * 60 * 60 * 1_000));
  assert.equal(created.at(-1).when, NOW + (24 * 60 * 60 * 1_000));
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].lastCheckAt, null);
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].anchorAt, new Date(NOW).toISOString());
});

test("fresh install schedules the first background check at the normal interval", async () => {
  const storage = memoryStorage();
  const { alarms, created } = alarmRecorder();
  const scheduler = createNativeRuntimeScheduler({
    alarms,
    storage,
    check: async () => ({ state: "runtime_ready" }),
    now: () => NOW,
    random: () => 0.5,
  });

  const scheduledAt = await scheduler.scheduleInitial();

  assert.equal(scheduledAt, NOW + (24 * 60 * 60 * 1_000));
  assert.equal(created.at(-1).when, scheduledAt);
  assert.equal(storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].lastCheckAt, null);
});

test("an immediate Bridge update check returns to the original install-time anchor", async () => {
  const installedAt = NOW - (6 * 60 * 60 * 1_000);
  const nextDailyCheck = installedAt + (24 * 60 * 60 * 1_000);
  const storage = memoryStorage({
    [NATIVE_RUNTIME_SCHEDULE_KEY]: {
      schemaVersion: 2,
      anchorAt: new Date(installedAt).toISOString(),
      failureCount: 0,
      lastCheckAt: null,
      nextCheckAt: new Date(nextDailyCheck).toISOString(),
      lastTrigger: "schedule_initialized",
    },
  });
  const { alarms, created } = alarmRecorder();
  const triggers = [];
  const scheduler = createNativeRuntimeScheduler({
    alarms,
    storage,
    check: async (trigger) => {
      triggers.push(trigger);
      return { state: "runtime_ready", update: { phase: "idle" } };
    },
    now: () => NOW,
  });

  await scheduler.checkNow("installed_update");

  assert.deepEqual(triggers, ["installed_update"]);
  assert.equal(created.at(-1).when, nextDailyCheck);
  assert.equal(
    storage.value[NATIVE_RUNTIME_SCHEDULE_KEY].anchorAt,
    new Date(installedAt).toISOString(),
  );
});

test("pending updates retry soon and retryable failures back off with a cap", () => {
  assert.equal(nextRuntimeCheckDelay({
    outcome: { state: "runtime_busy", update: { phase: "waiting_for_idle" } },
    random: () => 0.5,
  }), 15 * 60 * 1_000);
  assert.equal(nextRuntimeCheckDelay({
    outcome: { state: "runtime_failed", retryable: true },
    failureCount: 3,
    random: () => 0.5,
  }), 60 * 60 * 1_000);
  assert.equal(nextRuntimeCheckDelay({
    outcome: { state: "runtime_failed", retryable: true },
    failureCount: 8,
    random: () => 0.5,
  }), 6 * 60 * 60 * 1_000);
  assert.equal(nextRuntimeCheckDelay({
    outcome: {
      state: "runtime_ready",
      retryable: true,
      errorCode: "update_check_failed",
      update: { phase: "checking" },
    },
    failureCount: 3,
    random: () => 0.5,
  }), 60 * 60 * 1_000);
});

test("nonretryable update failures return to the normal check interval", () => {
  for (const [phase, errorCode] of [
    ["verifying", "signature_invalid"],
    ["rolling_back", "rollback_failed"],
  ]) {
    assert.equal(nextRuntimeCheckDelay({
      outcome: {
        state: "runtime_ready",
        retryable: false,
        errorCode,
        update: { phase },
      },
      random: () => 0.5,
    }), 24 * 60 * 60 * 1_000);
  }
});

function alarmRecorder() {
  const created = [];
  return {
    created,
    alarms: {
      async clear() {},
      async create(name, options) {
        created.push({ name, ...options });
      },
    },
  };
}

function memoryStorage(initial = {}) {
  const storage = {
    value: structuredClone(initial),
    async get(key) {
      return { [key]: structuredClone(this.value[key]) };
    },
    async set(values) {
      Object.assign(this.value, structuredClone(values));
    },
  };
  return storage;
}
