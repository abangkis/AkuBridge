import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Instagram navigation fallback is passive and final capture readiness remains authoritative", () => {
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const fallbackStart = worker.indexOf("async function probeRegisteredSourceReadiness");
  const fallbackEnd = worker.indexOf("function tabNavigationReady", fallbackStart);
  const passiveProbe = worker.slice(fallbackStart, fallbackEnd);

  assert.ok(fallbackStart > 0 && fallbackEnd > fallbackStart);
  assert.match(passiveProbe, /chrome\.tabs\.sendMessage/);
  assert.doesNotMatch(passiveProbe, /executeScript|SOURCE_SCRIPT_FILES/);
  assert.match(worker, /isCanonicalFeedUrl/);
  assert.match(worker, /const prepared = await prepareSourceTab/);
  assert.match(worker, /readiness = await waitForSourceReady/);
  assert.match(worker, /shouldRecoverManagedSurface/);
  assert.match(worker, /managed_adapter_readiness_recreated/);
  assert.match(worker, /findReadyReusableSourceTab/);
  assert.match(worker, /ready_inactive_canonical_tab/);
  assert.match(worker, /recoveryHint/);
});
