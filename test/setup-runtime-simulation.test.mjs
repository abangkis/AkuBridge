import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_INSTALL_REQUIRED_SIMULATION,
  RUNTIME_RUNNING_SIMULATION,
  RUNTIME_STOPPED_SIMULATION,
  RUNTIME_UPDATE_REQUIRED_SIMULATION,
  RUNTIME_VERSION_CONFLICT_SIMULATION,
  simulatedRuntimeOutcome,
} from "../setup-runtime-simulation.js";

test("setup can simulate a first-run runtime download state", () => {
  assert.equal(RUNTIME_INSTALL_REQUIRED_SIMULATION, "not-installed");
  assert.deepEqual(
    simulatedRuntimeOutcome("?simulateRuntime=not-installed"),
    { state: "runtime_install_required" },
  );
});

test("setup ignores absent or unsupported runtime simulations", () => {
  assert.equal(simulatedRuntimeOutcome(""), null);
  assert.equal(simulatedRuntimeOutcome("?simulateRuntime=ready"), null);
  assert.equal(simulatedRuntimeOutcome("?another=value"), null);
});

test("setup simulates update, stopped, and running runtime states", () => {
  const update = simulatedRuntimeOutcome(`?simulateRuntime=${RUNTIME_UPDATE_REQUIRED_SIMULATION}`);
  const stopped = simulatedRuntimeOutcome(`?simulateRuntime=${RUNTIME_STOPPED_SIMULATION}`);
  const running = simulatedRuntimeOutcome(`?simulateRuntime=${RUNTIME_RUNNING_SIMULATION}`);

  assert.equal(update.state, "runtime_incompatible");
  assert.equal(update.response.update.currentVersion, "0.7.9");
  assert.equal(stopped.response.runtime.processState, "stopped");
  assert.equal(running.state, "runtime_ready");
  assert.equal(running.response.runtime.processState, "ready");
});

test("setup simulates an occupied version conflict", () => {
  assert.deepEqual(
    simulatedRuntimeOutcome(`?simulateRuntime=${RUNTIME_VERSION_CONFLICT_SIMULATION}`),
    { state: "runtime_incompatible" },
  );
});
