import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_INSTALL_REQUIRED_SIMULATION,
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
