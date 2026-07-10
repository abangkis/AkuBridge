import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AkuBridge has a narrow read-only permission contract", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:47821/*",
    "https://www.linkedin.com/*",
    "https://x.com/*",
  ]);

  const source = ["service-worker.js", "content-script.js", "aku-browser-tab-bridge.js"]
    .map((file) => fs.readFileSync(path.join(projectRoot, file), "utf8"))
    .join("\n");
  for (const forbidden of [
    "chrome.cookies",
    "chrome.history",
    "chrome.debugger",
    "chrome.webRequest",
    "data-testid=\"like\"",
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must remain absent`);
  }
  assert.equal(source.includes("SIGNAL" + "_GATEWAY"), false);
  assert.equal(source.includes("X-" + "Signal-Bridge"), false);
});

test("AkuBridge recognizes the current LinkedIn feed container", () => {
  const contentScript = fs.readFileSync(
    path.join(projectRoot, "content-script.js"),
    "utf8",
  );

  assert.match(
    contentScript,
    /\[data-testid="mainFeed"\] \[role="listitem"\]/,
  );
  assert.match(contentScript, /linkedin-dom-v2/);
  assert.match(contentScript, /\[data-view-name="feed-full-update"\]/);
  assert.match(contentScript, /\.feed-shared-update-v2/);
  assert.doesNotMatch(
    contentScript,
    /normalizeHttpUrl\(match\?\.href\) \|\| window\.location\.href/,
  );
});
