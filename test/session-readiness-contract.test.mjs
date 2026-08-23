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
  assert.match(worker, /sourceAccessGranted\(chrome, source\)/);
  assert.match(worker, /source-permission\.html\?source=/);
  assert.match(worker, /state: "permission_required"/);
  assert.match(worker, /chrome\.tabs\.create\(\{ url: definition\.feedUrl, active: true \}\)/);
  assert.match(relay, /AKU_BROWSER_PROBE_SOURCE_SESSIONS/);
  assert.match(relay, /AKU_BROWSER_SOURCE_SESSIONS_RESULT/);
  assert.match(relay, /AKU_BROWSER_OPEN_SOURCE/);
  assert.match(relay, /AKU_BROWSER_SOURCE_PERMISSION_REQUIRED/);
  assert.match(relay, /const allowedOrigin = window\.location\.origin/);
  assert.doesNotMatch(worker, /chrome\.cookies/);
  assert.doesNotMatch(worker, /chrome\.history/);
});

test("source permission page requests only the allowlisted source then continues to its canonical feed", () => {
  const page = fs.readFileSync(path.join(projectRoot, "source-permission.html"), "utf8");
  const script = fs.readFileSync(path.join(projectRoot, "source-permission.js"), "utf8");
  const verifier = fs.readFileSync(path.join(projectRoot, "scripts", "verify-extension-package.mjs"), "utf8");

  assert.match(page, /Allow and continue/);
  assert.match(page, /either its feed or its own sign-in page/);
  assert.match(script, /sourceAccessDefinition\(source\)/);
  assert.match(script, /sourceDefinition\(source\)/);
  assert.match(script, /chrome\.permissions\.request\(\{ origins: access\.origins \}\)/);
  assert.match(script, /AKU_BROWSER_RECONCILE_SOURCE_ACCESS/);
  assert.match(script, /globalThis\.location\.replace\(catalog\.feedUrl\)/);
  assert.doesNotMatch(script, /(?:return|redirect|url)=/i);
  assert.match(verifier, /addReference\("source-permission\.html"\)/);
});

test("source session result remains separate from Bridge heartbeat capabilities", () => {
  const relay = fs.readFileSync(path.join(projectRoot, "aku-browser-tab-bridge.js"), "utf8");
  assert.match(relay, /AKU_BROWSER_SOURCE_SESSIONS_RESULT/);
  assert.doesNotMatch(relay, /AKU_BROWSER_BRIDGE_READY[\s\S]{0,500}sessions/);
});
