import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeCapabilities } from "../bridge-capabilities.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AkuBridge has a narrow read-only permission contract", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"),
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.version, "0.6.5");
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:47821/*",
    "https://www.linkedin.com/*",
    "https://x.com/*",
  ]);

  const source = [
    "service-worker.js",
    "content-script.js",
    "linkedin-permalink-policy.js",
    "linkedin-timestamp-policy.js",
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
  assert.match(linkedInAdapter, /linkedin-dom-v15/);
  assert.match(contentScript, /platformId/);
  assert.match(contentScript, /findMedia/);
  assert.match(xAdapter, /tweetPhoto/);
  assert.match(xAdapter, /previewInterstitial/);
  assert.match(contentScript, /source-fidelity-v53/);
  assert.match(contentScript, /relative_text_estimate/);
  assert.match(contentScript, /not_exposed_promoted/);
  assert.match(contentScript, /LINKEDIN_PERMALINK_RECOVERY_BUDGET_MS = 2_000/);
  assert.match(contentScript, /CAPTURE_DEADLINE_RESERVE_MS = 2_000/);
  assert.match(contentScript, /LINKEDIN_MAX_BLOCKS_PER_SNAPSHOT = 8/);
  assert.match(contentScript, /Math\.min\(payload\.maxBlocksPerSnapshot, LINKEDIN_MAX_BLOCKS_PER_SNAPSHOT\)/);
  assert.match(contentScript, /plan\.captureTimeoutMs - CAPTURE_DEADLINE_RESERVE_MS/);
  assert.match(contentScript, /const deadlineAtMs = Math\.min\(/);
  assert.match(contentScript, /LinkedIn permalink recovery budget was exhausted for this snapshot/);
  assert.match(contentScript, /adapterRuntimeRevision/);
  assert.match(contentScript, /adapterVersion: sourceAdapters\.get\(source\)\.version/);
  assert.match(contentScript, /AKU_BROWSER_CAPTURE_DIAGNOSTICS/);
  assert.match(contentScript, /AKU_BROWSER_CAPTURE_DELAY/);
  assert.match(contentScript, /updateCaptureProgress\("scroll_settling"/);
  assert.match(contentScript, /updateCaptureProgress\("extracting_block"/);
  assert.match(contentScript, /const deadlineAtMs = Date\.now\(\) \+ attempts \* intervalMs/);
  assert.match(contentScript, /await delay\(Math\.min\(intervalMs, remainingMs\)\)/);
  assert.match(contentScript, /return read\(\) \|\| null/);
  assert.match(xAdapter, /img\[src\*="\/card_img\/"\]/);
  assert.match(contentScript, /style\*="\/card_img\/"/);
  assert.match(contentScript, /tweetPhoto.*background-image/);
  assert.match(contentScript, /UserAvatar-Container-/);
  assert.match(contentScript, /renderedBackgroundUrl\(avatarRoot\)/);
  assert.match(contentScript, /tweet-text-show-more-link/);
  assert.match(contentScript, /expanded_no_restore_control/);
  assert.match(contentScript, /expandable-text-button/);
  assert.match(contentScript, /contentExpansion/);
  assert.match(linkedInAdapter, /contentRootSelector/);
  assert.match(contentScript, /removeListener/);
  assert.match(contentScript, /querySelectorAll\("video"\)/);
  assert.match(contentScript, /renderedBackgroundUrl/);
  assert.match(contentScript, /videoPlayer/);
  assert.match(contentScript, /structuredText/);
  assert.match(contentScript, /summarizeVisualHydration/);
  assert.match(contentScript, /hydratedPrimaryAvatarCount/);
  assert.match(xAdapter, /\[aria-label\*="Video" i\]/);
  assert.match(contentScript, /excludeRoot/);
  assert.match(contentScript, /findXQuotedPostContainer/);
  assert.doesNotMatch(contentScript, /container\.querySelectorAll\("img"\).*profile_images/s);
  assert.match(contentScript, /media\.some\(\(entry\) => entry\.kind === "video"\)/);
  assert.match(xAdapter, /videoComponent.*img/);
  assert.match(xAdapter, /a\[href\*="\/status\/"\]\[href\*="\/photo\/"\]/);
  assert.match(contentScript, /sourceAdapters\.get\(source\)\.qualitySelectors\?\.media/);
  assert.match(contentScript, /mediaSelector \? container\.querySelector\(mediaSelector\) : null/);
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
  const xAdapter = fs.readFileSync(
    path.join(projectRoot, "adapters", "x-adapter.js"),
    "utf8",
  );
  const freshnessRuntime = fs.readFileSync(
    path.join(projectRoot, "source-freshness-runtime.js"),
    "utf8",
  );
  const mediaAcquisitionEngine = fs.readFileSync(
    path.join(projectRoot, "media-acquisition-engine.js"),
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
  assert.match(freshnessRuntime, /signal\.element\.click\(\)/);
  assert.match(freshnessRuntime, /evidence: "feed_fingerprint_changed"/);
  assert.doesNotMatch(freshnessRuntime, /evidence: "signal_removed"/);
  assert.match(freshnessRuntime, /candidate\.contains\(element\)/);
  assert.match(freshnessRuntime, /adapter\.freshness\.revealObservationMs/);
  assert.match(linkedInAdapter, /revealObservationMs: 12_000/);
  assert.match(linkedInAdapter, /rejectInsideFeedCandidate: true/);
  assert.match(mediaAcquisitionEngine, /media-acquisition-engine-v1/);
  assert.match(mediaAcquisitionEngine, /structured_state/);
  assert.match(mediaAcquisitionEngine, /primary_hydration/);
  assert.match(mediaAcquisitionEngine, /alternate_dom/);
  assert.match(mediaAcquisitionEngine, /quiet_recovery_unsupported/);
  assert.doesNotMatch(mediaAcquisitionEngine, /source\s*===\s*["'](?:x|linkedin)["']/);
  assert.match(xAdapter, /x-media-acquisition-v1/);
  assert.match(linkedInAdapter, /linkedin-media-acquisition-v1/);
  assert.match(contentScript, /mediaAcquisitionEngine\.acquire/);
  assert.match(contentScript, /const captureVisibilityMode =\s*payload\.tabAcquisition\?\.captureVisibilityMode \?\? "same_window"/);
  assert.match(contentScript, /operationDeadlineAtMs,\s*captureVisibilityMode,\s*\);/);
  assert.doesNotMatch(contentScript, /captureVisibilityMode: payload\.tabAcquisition/);
  assert.match(contentScript, /fallbackUsed: mediaAcquisition\.outcomes\.recovered > 0/);
  assert.match(contentScript, /restorationScope: feedMutation \? "post_reveal_start"/);
  assert.equal(freshnessRuntime.match(/signal\.element\.click\(\)/g)?.length, 1);
  assert.equal(contentScript.match(/menuButton\.click\(\)/g)?.length, 2);
  assert.doesNotMatch(contentScript, /(?:like|comment|repost|send)Button\.click\(\)/i);
});

test("LinkedIn capture composes readiness with generic freshness recovery", () => {
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const recovery = fs.readFileSync(path.join(projectRoot, "source-freshness-recovery.js"), "utf8");

  assert.match(contentScript, /AKU_BROWSER_PROBE_SOURCE_READY/);
  assert.match(contentScript, /selector_mismatch/);
  assert.match(contentScript, /login_required/);
  assert.match(worker, /waitForSourceReady/);
  assert.match(worker, /collectFromTabWithDeadline/);
  assert.match(worker, /bounded response deadline/);
  assert.match(worker, /recoverSourceFreshness/);
  assert.match(worker, /probeSourceFreshness/);
  assert.match(recovery, /source-freshness-recovery-v1/);
  assert.doesNotMatch(worker, /sourceReadinessRetryCount: 1/);
  assert.doesNotMatch(worker, /pendingContentPolicy: "detect_only"/);
  assert.match(worker, /restoreTabFocus/);
  assert.match(worker, /workingTabPreserved = prepared\.workingTabPreserved === true/);
  assert.doesNotMatch(worker, /workingTabPreserved = focusOutcome\.preserved/);
});

test("background X capture activates for the full bounded capture so scrolled media can hydrate", () => {
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert.match(worker, /source === "x" && backgroundAtDispatch/);
  assert.match(
    worker,
    /if \(source === "x" && backgroundAtDispatch\) \{[\s\S]*?await activate\(\);[\s\S]*?waitForSourceReady\([\s\S]*?\{ requireVisualHydration \}/,
  );
  assert.match(worker, /const requireVisualHydration = options\.requireVisualHydration \?\? source === "x"/);
  assert.match(worker, /requireVisualHydration: !targetUrl \|\| visibilityPlan\.foregroundAuthorized/);
  assert.match(worker, /function isSourceCaptureReady\(readiness\) \{\s*return readiness\.state === "feed_ready";/);
  assert.match(worker, /restoreTabFocus/);
  assert.doesNotMatch(worker, /X_BACKGROUND_PROBE_TIMEOUT_MS/);
  assert.doesNotMatch(worker, /isTerminalReadiness/);
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
  assert.match(tabBridge, /AKU_BROWSER_BRIDGE_RELOAD_SELF/);
  assert.match(tabBridge, /AKU_BROWSER_MEDIA_RECAPTURE/);
  assert.match(tabBridge, /capabilities: response\.capabilities/);
  const capabilities = createBridgeCapabilities({ version: "0.6.5", manifest_version: 3 });
  assert.equal(capabilities.runtimeRevision, "source-fidelity-v53");
  assert.equal(capabilities.buildId, "aku-bridge-0.6.5-source-fidelity-v53");
  assert.equal(capabilities.contractVersion, "aku-browser.bridge.v2");
  assert.deepEqual(capabilities.adapterVersions, { x: "x-dom-v17", linkedin: "linkedin-dom-v15" });
  assert.ok(capabilities.actions.includes("reload_self"));
  assert.ok(capabilities.actions.includes("report_capture_quality"));
  assert.ok(capabilities.actions.includes("recover_source_freshness"));
  assert.ok(capabilities.actions.includes("acquire_missing_media"));
  assert.ok(capabilities.actions.includes("recapture_missing_media"));
  assert.match(worker, /dispatchMediaRecapture/);
  assert.match(worker, /assertRecaptureTarget/);
  assert.match(worker, /managed\.openTargetTab/);
  assert.match(worker, /managed\.requireFocus\("target_loaded"\)/);
  assert.match(worker, /foregroundAuthorized/);
  assert.match(worker, /managed\.showForeground/);
  assert.match(worker, /managed_window_foreground/);
  assert.match(worker, /if \(managed\) await managed\.verifyFocus\(\)\.catch/);
  assert.ok(capabilities.actions.includes("manage_capture_window"));
  assert.ok(capabilities.actions.includes("release_capture_surface"));
  assert.ok(capabilities.actions.includes("preserve_working_tab"));
  assert.match(tabBridge, /capability handshake returned no capabilities/);
  assert.match(worker, /chrome\.storage\.local\.set/);
  assert.match(worker, /resumePendingSelfReload/);
  assert.match(worker, /current\.runtimeRevision === expected\.runtimeRevision/);
  assert.match(worker, /current\.adapterVersion === expected\.adapterVersions\[source\]/);
  assert.match(worker, /Last content stage:/);
  assert.match(worker, /message\?\.type === "AKU_BROWSER_CAPTURE_DELAY"/);
  assert.match(worker, /isTrustedSourceContentSender/);
  assert.match(worker, /chrome\.tabs\.reload\(pending\.tabId\)/);
  assert.doesNotMatch(tabBridge, /setTimeout[\s\S]*location\.reload/);
  assert.match(tabBridge, /AKU_BROWSER_BRIDGE_ERROR/);
  assert.equal(capabilities.authority, "read_only_bounded");
  assert.deepEqual(capabilities.captureLimits, { maxScrolls: 6, maxSnapshots: 7, maxBlocksPerSnapshot: 20 });
  assert.match(worker, /assertTabLease\(prepared\.lease, "before_capture"\)/);
  assert.match(worker, /assertTabLease\(prepared\.lease, "after_capture"\)/);
  assert.match(worker, /chrome\.runtime\.reload\(\)/);
  assert.doesNotMatch(worker, /chrome\.(management|debugger)/);
  assert.match(runtimePolicy, /serializeBridgeError/);
});
