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

  const source = [
    "service-worker.js",
    "content-script.js",
    "linkedin-permalink-policy.js",
    "source-adapter-runtime.js",
    "adapters/x-adapter.js",
    "adapters/linkedin-adapter.js",
    "aku-browser-tab-bridge.js",
  ]
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
  const linkedInAdapter = fs.readFileSync(
    path.join(projectRoot, "adapters", "linkedin-adapter.js"),
    "utf8",
  );
  const xAdapter = fs.readFileSync(
    path.join(projectRoot, "adapters", "x-adapter.js"),
    "utf8",
  );

  assert.match(
    linkedInAdapter,
    /\[data-testid="mainFeed"\] \[role="listitem"\]/,
  );
  assert.match(linkedInAdapter, /linkedin-dom-v2/);
  assert.match(contentScript, /platformId/);
  assert.match(contentScript, /findMedia/);
  assert.match(xAdapter, /tweetPhoto/);
  assert.match(xAdapter, /previewInterstitial/);
  assert.match(contentScript, /x-source-presentation-v3/);
  assert.match(contentScript, /removeListener/);
  assert.match(contentScript, /video\[poster\]/);
  assert.match(contentScript, /videoPlayer/);
  assert.match(contentScript, /mediaUrlFromCssBackground/);
  assert.match(linkedInAdapter, /\[data-view-name="feed-full-update"\]/);
  assert.match(linkedInAdapter, /\.feed-shared-update-v2/);
  assert.doesNotMatch(
    contentScript,
    /normalizeHttpUrl\(match\?\.href\) \|\| window\.location\.href/,
  );
});

test("AkuBridge uses LinkedIn's scroll root and one allowlisted fresh-content activation", () => {
  const contentScript = fs.readFileSync(
    path.join(projectRoot, "content-script.js"),
    "utf8",
  );
  const linkedInAdapter = fs.readFileSync(
    path.join(projectRoot, "adapters", "linkedin-adapter.js"),
    "utf8",
  );

  assert.match(contentScript, /document\.querySelector\("#workspace"\)/);
  assert.match(contentScript, /isScrollableElement/);
  assert.match(contentScript, /nearestScrollableAncestor/);
  assert.match(contentScript, /scrollContext\.scrollTop \+= top/);
  assert.match(contentScript, /window\.scrollTo\(window\.scrollX, window\.scrollY \+ top\)/);
  assert.match(contentScript, /attempt < 3/);
  assert.doesNotMatch(contentScript, /behavior: "instant"/);
  assert.match(contentScript, /windowVisibleSelectorCandidateCount/);
  assert.match(linkedInAdapter, /actionAnchoredCandidates/);
  assert.match(linkedInAdapter, /actionKinds\.size >= 2/);
  assert.match(contentScript, /pendingNewContent/);
  assert.match(contentScript, /Pending new content signal detected/);
  assert.match(contentScript, /plan\.pendingContentPolicy === "reveal_if_present"/);
  assert.match(contentScript, /signal\.element\.click\(\)/);
  assert.match(contentScript, /evidence = "feed_fingerprint_changed"/);
  assert.doesNotMatch(contentScript, /evidence = "signal_removed"/);
  assert.match(contentScript, /restorationScope: feedMutation \? "post_reveal_start"/);
  assert.equal(contentScript.match(/signal\.element\.click\(\)/g)?.length, 1);
  assert.equal(contentScript.match(/menuButton\.click\(\)/g)?.length, 2);
  assert.doesNotMatch(contentScript, /(?:like|comment|repost|send)Button\.click\(\)/i);
});

test("LinkedIn capture waits for feed readiness and permits only one evidence retry", () => {
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");

  assert.match(contentScript, /AKU_BROWSER_PROBE_SOURCE_READY/);
  assert.match(contentScript, /selector_mismatch/);
  assert.match(contentScript, /login_required/);
  assert.match(worker, /waitForSourceReady/);
  assert.match(worker, /collectFromTabWithDeadline/);
  assert.match(worker, /bounded response deadline/);
  assert.match(worker, /sourceReadinessRetryCount: 1/);
  assert.match(worker, /pendingContentPolicy: "detect_only"/);
  assert.match(worker, /restoreTabFocus/);
  assert.equal(worker.match(/sourceReadinessRetryCount: 1/g)?.length, 1);
});

test("initial stale-tab recovery is bounded and follow-up remains anchored", () => {
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");

  assert.match(worker, /captureWithSourceTabRecovery/);
  assert.match(worker, /acquisitionRound: command\.payload\.acquisitionRound/);
  assert.match(contentScript, /sourceTabRecoveryCount/);
  assert.match(contentScript, /discarded one stale initial tab reference/);
});

test("AkuBridge exposes additive read-only capabilities and structured failures", () => {
  const tabBridge = fs.readFileSync(path.join(projectRoot, "aku-browser-tab-bridge.js"), "utf8");
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const runtimePolicy = fs.readFileSync(path.join(projectRoot, "bridge-runtime-policy.js"), "utf8");

  assert.match(tabBridge, /AKU_BRIDGE_GET_CAPABILITIES/);
  assert.match(tabBridge, /capabilities: response\.capabilities/);
  assert.match(tabBridge, /capability handshake returned no capabilities/);
  assert.match(tabBridge, /AKU_BROWSER_BRIDGE_ERROR/);
  assert.match(worker, /authority: "read_only_bounded"/);
  assert.match(worker, /captureLimits: \{ maxScrolls: 2, maxSnapshots: 3, maxBlocksPerSnapshot: 20 \}/);
  assert.match(worker, /assertTabLease\(prepared\.lease, "before_capture"\)/);
  assert.match(worker, /assertTabLease\(prepared\.lease, "after_capture"\)/);
  assert.match(runtimePolicy, /serializeBridgeError/);
});
