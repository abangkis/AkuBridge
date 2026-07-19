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
  assert.equal(manifest.version_name, packageJson.version);
  assert.equal(manifest.version, "0.7.0.2");
  assert.equal(manifest.version_name, "0.7.0-preview.2");
  assert.deepEqual(manifest.permissions.sort(), ["scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:11122/*",
    "https://facebook.com/*",
    "https://www.facebook.com/*",
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
    "adapters/facebook-adapter.js",
    "aku-browser-tab-bridge.js",
    "x-media-evidence-runtime.js",
    "x-media-evidence-store.js",
    "x-avatar-evidence-store.js",
    "x-response-evidence-adapter.js",
    "x-main-world-media-resolver.js",
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
  assert.match(linkedInAdapter, /linkedin-dom-v16/);
  assert.match(contentScript, /platformId/);
  assert.match(contentScript, /findMedia/);
  assert.match(xAdapter, /tweetPhoto/);
  assert.match(xAdapter, /previewInterstitial/);
  assert.match(contentScript, /source-adapters-v72/);
  assert.match(contentScript, /plan\.scrollFraction \* scrollStepMultiplier/);
  assert.match(contentScript, /captureQuality\.verdict === "invalid"/);
  assert.match(contentScript, /relative_text_estimate/);
  assert.match(contentScript, /not_exposed_promoted/);
  assert.match(linkedInAdapter, /recoverLinkedInPermalinks/);
  assert.match(contentScript, /CAPTURE_DEADLINE_RESERVE_MS = 2_000/);
  assert.match(linkedInAdapter, /maxBlocksPerSnapshot: 8/);
  assert.match(contentScript, /adapter\.maxBlocksPerSnapshot \?\? payload\.maxBlocksPerSnapshot/);
  assert.match(contentScript, /plan\.captureTimeoutMs - CAPTURE_DEADLINE_RESERVE_MS/);
  assert.match(linkedInAdapter, /const deadlineAtMs = Math\.min\(/);
  assert.match(linkedInAdapter, /LinkedIn permalink recovery budget was exhausted for this snapshot/);
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
  assert.match(xAdapter, /style\*="\/card_img\/"/);
  assert.match(xAdapter, /tweetPhoto.*background-image/);
  assert.match(xAdapter, /UserAvatar-Container-/);
  assert.match(contentScript, /renderedBackgroundUrl\(avatarRoot\)/);
  assert.match(xAdapter, /tweet-text-show-more-link/);
  assert.match(contentScript, /expanded_no_restore_control/);
  assert.match(linkedInAdapter, /expandable-text-button/);
  assert.match(contentScript, /contentExpansion/);
  assert.match(linkedInAdapter, /contentRootSelector/);
  assert.match(contentScript, /removeListener/);
  assert.match(contentScript, /querySelectorAll\("video"\)/);
  assert.match(contentScript, /renderedBackgroundUrl/);
  assert.match(xAdapter, /videoPlayer/);
  assert.match(contentScript, /structuredText/);
  assert.match(contentScript, /summarizeVisualHydration/);
  assert.match(contentScript, /hydratedPrimaryAvatarCount/);
  assert.match(xAdapter, /\[aria-label\*="Video" i\]/);
  assert.match(contentScript, /excludeRoot/);
  assert.match(xAdapter, /findQuotedRoot: findQuotedPostContainer/);
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

  assert.match(linkedInAdapter, /"#workspace"/);
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
  assert.match(mediaAcquisitionEngine, /media-acquisition-engine-v3/);
  assert.match(mediaAcquisitionEngine, /structured_state/);
  assert.match(mediaAcquisitionEngine, /primary_hydration/);
  assert.match(mediaAcquisitionEngine, /alternate_dom/);
  assert.match(mediaAcquisitionEngine, /quiet_recovery_unsupported/);
  assert.doesNotMatch(mediaAcquisitionEngine, /source\s*===\s*["'](?:x|linkedin)["']/);
  assert.match(xAdapter, /x-media-acquisition-v2/);
  assert.match(linkedInAdapter, /linkedin-media-acquisition-v1/);
  assert.match(contentScript, /mediaAcquisitionEngine\.acquire/);
  assert.match(contentScript, /const captureVisibilityMode =\s*payload\.tabAcquisition\?\.captureVisibilityMode \?\? "same_window"/);
  assert.match(
    contentScript,
    /operationDeadlineAtMs,\s*captureVisibilityMode,\s*structuredMediaRuntime,\s*\);/,
  );
  assert.doesNotMatch(contentScript, /captureVisibilityMode: payload\.tabAcquisition/);
  assert.match(contentScript, /fallbackUsed: mediaAcquisition\.outcomes\.recovered > 0/);
  assert.match(contentScript, /restorationScope: feedMutation \? "post_reveal_start"/);
  assert.equal(freshnessRuntime.match(/signal\.element\.click\(\)/g)?.length, 1);
  assert.equal(linkedInAdapter.match(/menuButton\.click\(\)/g)?.length, 2);
  assert.doesNotMatch(contentScript, /(?:like|comment|repost|send)Button\.click\(\)/i);
});

test("LinkedIn capture composes readiness with generic freshness recovery", () => {
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const recovery = fs.readFileSync(path.join(projectRoot, "source-freshness-recovery.js"), "utf8");

  assert.match(contentScript, /AKU_BROWSER_PROBE_SOURCE_READY/);
  assert.match(contentScript, /selector_mismatch/);
  assert.match(contentScript, /login_required/);
  assert.match(contentScript, /adapter\.availability/);
  assert.match(contentScript, /availability\?\.state/);
  assert.match(worker, /waitForSourceReady/);
  assert.match(worker, /collectFromTabWithDeadline/);
  assert.match(worker, /bounded response deadline/);
  assert.match(worker, /recoverSourceFreshness/);
  assert.match(worker, /probeSourceFreshness/);
  assert.match(recovery, /source-freshness-recovery-v1/);
  assert.doesNotMatch(worker, /sourceReadinessRetryCount: 1/);
  assert.doesNotMatch(worker, /pendingContentPolicy: "detect_only"/);
  assert.match(worker, /restoreTabFocus/);
  assert.match(worker, /managedCaptureWindow\.releaseSource\(source, captureLeaseId\)/);
  assert.match(worker, /readiness\.state === "source_unavailable"/);
  assert.match(worker, /new AkuBridgeError\(\s*"source_unavailable"/);
  assert.match(worker, /\["visible_recovery_required", "source_unavailable", "login_required"\]\.includes\(error\?\.code\)/);
  assert.match(worker, /workingTabPreserved = prepared\.workingTabPreserved === true/);
  assert.doesNotMatch(worker, /workingTabPreserved = focusOutcome\.preserved/);
});

test("background X capture activates for the full bounded capture so scrolled media can hydrate", () => {
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const surfaceTelemetry = fs.readFileSync(
    path.join(projectRoot, "capture-surface-telemetry.js"),
    "utf8",
  );
  assert.match(worker, /readinessPolicy\.activateWhenBackground === true && backgroundAtDispatch/);
  assert.match(
    worker,
    /if \(readinessPolicy\.activateWhenBackground === true && backgroundAtDispatch\) \{[\s\S]*?await activate\(\);[\s\S]*?waitForSourceReady\([\s\S]*?\{ requireVisualHydration \}/,
  );
  assert.match(worker, /const requireVisualHydration = options\.requireVisualHydration \?\? sourceRequiresVisualHydration\(source\)/);
  assert.match(worker, /requireVisualHydration: !targetUrl \|\| visibilityPlan\.foregroundAuthorized/);
  assert.match(worker, /function isSourceCaptureReady\(readiness\) \{\s*return readiness\.state === "feed_ready";/);
  assert.match(worker, /restoreTabFocus/);
  assert.doesNotMatch(worker, /X_BACKGROUND_PROBE_TIMEOUT_MS/);
  assert.doesNotMatch(worker, /isTerminalReadiness/);
  assert.match(worker, /inspectCaptureSurface/);
  assert.match(contentScript, /captureWindowState/);
  assert.match(contentScript, /captureTabActive/);
  assert.match(surfaceTelemetry, /windowFocused/);
});

test("X media enrichment stays passive, bounded, and media-only", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  const contentScript = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  const tabBridge = fs.readFileSync(path.join(projectRoot, "aku-browser-tab-bridge.js"), "utf8");
  const evidenceRuntime = fs.readFileSync(path.join(projectRoot, "x-media-evidence-runtime.js"), "utf8");
  const responseAdapter = fs.readFileSync(path.join(projectRoot, "x-response-evidence-adapter.js"), "utf8");
  const responseEntry = manifest.content_scripts.find((entry) =>
    entry.run_at === "document_start" && entry.js?.includes("x-response-evidence-adapter.js"),
  );
  const earlyEntry = manifest.content_scripts.find((entry) =>
    entry.run_at === "document_start" && entry.js?.includes("x-media-evidence-runtime.js"),
  );
  assert.deepEqual(earlyEntry?.matches, ["https://x.com/*"]);
  assert.deepEqual(responseEntry?.matches, ["https://x.com/*"]);
  assert.equal(responseEntry?.world, "MAIN");
  assert.match(worker, /world: "MAIN"/);
  assert.match(worker, /createXMediaEvidenceStore/);
  assert.match(worker, /AKU_X_MEDIA_EVIDENCE_OBSERVED/);
  assert.match(worker, /AKU_X_AVATAR_EVIDENCE_OBSERVED/);
  assert.match(worker, /AKU_X_AVATAR_EVIDENCE_LOOKUP/);
  assert.match(contentScript, /hydratePersistentAvatarEvidence/);
  assert.match(
    contentScript,
    /hydratePersistentAvatarEvidence\(\s*boundedContainers,\s*operationDeadlineAtMs,\s*structuredMediaRuntime,/,
  );
  assert.match(tabBridge, /AKU_BROWSER_X_MEDIA_EVIDENCE_LOOKUP/);
  assert.match(evidenceRuntime, /maxCandidates: 128/);
  assert.match(evidenceRuntime, /ttlMs: 30 \* 60 \* 1_000/);
  assert.match(responseAdapter, /x-response-evidence-v2/);
  assert.match(responseAdapter, /HomeTimeline\|HomeLatestTimeline\|TweetDetail/);
  assert.match(responseAdapter, /maxBodyBytes/);
  assert.match(responseAdapter, /x_response_graphql/);
  assert.match(responseAdapter, /profile_images/);
  assert.match(evidenceRuntime, /createAvatarCache/);
  assert.match(evidenceRuntime, /lookupAvatarContainer/);
  assert.doesNotMatch(responseAdapter, /chrome\.(?:tabs|windows|debugger|webRequest)/);
  assert.doesNotMatch(evidenceRuntime, /rawGraphQlResponse|full_text/);
  const lookupHandler = worker.slice(
    worker.indexOf('message?.type === "AKU_BROWSER_X_MEDIA_EVIDENCE_LOOKUP"'),
    worker.indexOf('message?.type === "AKU_BRIDGE_GET_CAPABILITIES"'),
  );
  assert.doesNotMatch(lookupHandler, /chrome\.tabs\.(?:create|update)/);
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
  const capabilities = createBridgeCapabilities({ version: "0.7.0.2", version_name: "0.7.0-preview.2", manifest_version: 3 });
  assert.equal(capabilities.extensionVersion, "0.7.0-preview.2");
  assert.equal(capabilities.runtimeRevision, "source-adapters-v72");
  assert.equal(capabilities.buildId, "aku-bridge-0.7.0-preview.2-source-adapters-v72");
  assert.equal(capabilities.contractVersion, "aku-browser.bridge.v2");
  assert.deepEqual(capabilities.adapterVersions, { x: "x-dom-v20", linkedin: "linkedin-dom-v16", facebook: "facebook-dom-v10" });
  assert.deepEqual(capabilities.mediaEvidenceAdapterVersions, { x: "x-response-evidence-v2" });
  assert.ok(capabilities.actions.includes("reload_self"));
  assert.ok(capabilities.actions.includes("report_capture_quality"));
  assert.ok(capabilities.actions.includes("recover_source_freshness"));
  assert.ok(capabilities.actions.includes("acquire_missing_media"));
  assert.ok(capabilities.actions.includes("recapture_missing_media"));
  assert.ok(capabilities.actions.includes("cache_passive_media_evidence"));
  assert.ok(capabilities.actions.includes("lookup_passive_media_evidence"));
  assert.ok(capabilities.actions.includes("observe_response_media_evidence"));
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
  assert.match(tabBridge, /AKU_BROWSER_DISPATCH_FAILED/);
  assert.equal(capabilities.authority, "read_only_bounded");
  assert.deepEqual(capabilities.captureLimits, { maxScrolls: 6, maxSnapshots: 7, maxBlocksPerSnapshot: 20 });
  assert.match(worker, /assertTabLease\(prepared\.lease, "before_capture"\)/);
  assert.match(worker, /assertTabLease\(prepared\.lease, "after_capture"\)/);
  assert.match(worker, /chrome\.runtime\.reload\(\)/);
  assert.doesNotMatch(worker, /chrome\.(management|debugger)/);
  assert.match(runtimePolicy, /serializeBridgeError/);
});
