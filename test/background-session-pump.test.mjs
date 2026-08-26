import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlightSessionPump } from "../background-session-pump.js";

test("session pump coalesces concurrent dispatch lanes", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const pump = createSingleFlightSessionPump(async () => {
    calls += 1;
    await blocked;
    return "completed";
  });

  const first = pump("http://127.0.0.1:11122", "token");
  const second = pump("http://127.0.0.1:11122", "token");
  assert.strictEqual(second, first);
  assert.equal(calls, 0);

  release();
  assert.equal(await first, "completed");
  assert.equal(calls, 1);
});

test("session pump can restart after completion or failure", async () => {
  let calls = 0;
  const pump = createSingleFlightSessionPump(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return calls;
  });

  await assert.rejects(pump(), /transient/);
  assert.equal(await pump(), 2);
});
