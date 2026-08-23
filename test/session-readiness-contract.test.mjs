import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("source session probe is passive, allowlisted, and relayed only to AkuBrowser", () => {
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const relay = fs.readFileSync(path.join(projectRoot, "aku-browser-tab-bridge.js"), "utf8");
  assert.match(worker, /AKU_BRIDGE_PROBE_SOURCE_SESSIONS/);
  assert.match(worker, /isAkuBrowserOrigin\(sender\.url\)/);
  assert.match(worker, /chrome\.tabs\.query\(\{ url: matchPatternsFor\(source\) \}\)/);
  assert.match(worker, /SOURCE_SESSION_MAX_TABS/);
  assert.match(worker, /async function openSourceFeed\(source\)/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: definition\.feedUrl, active: true \}\)/);
  assert.match(relay, /AKU_BROWSER_PROBE_SOURCE_SESSIONS/);
  assert.match(relay, /AKU_BROWSER_SOURCE_SESSIONS_RESULT/);
  assert.match(relay, /AKU_BROWSER_OPEN_SOURCE/);
  assert.match(relay, /const allowedOrigin = window\.location\.origin/);
  assert.doesNotMatch(worker, /chrome\.cookies/);
  assert.doesNotMatch(worker, /chrome\.history/);
});

test("source session result remains separate from Bridge heartbeat capabilities", () => {
  const relay = fs.readFileSync(path.join(projectRoot, "aku-browser-tab-bridge.js"), "utf8");
  assert.match(relay, /AKU_BROWSER_SOURCE_SESSIONS_RESULT/);
  assert.doesNotMatch(relay, /AKU_BROWSER_BRIDGE_READY[\s\S]{0,500}sessions/);
});
