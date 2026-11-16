import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { sourceDefinition } from "../source-catalog.js";
import {
  instagramStructuredFeedObservation,
  resolveInstagramStructuredFeedInMainWorld,
  shouldUseInstagramStructuredFeedFallback,
} from "../instagram-main-world-feed-resolver.js";

test("structured feed fallback is isolated to the exact Instagram empty-shell contract", () => {
  const valid = {
    source: "instagram",
    configuredFallback: "instagram_structured_feed_v1",
    readiness: {
      diagnosis: "feed_shell_unhydrated",
      feedRootPresent: true,
      selectorCandidateCount: 0,
      structuralCandidateCount: 0,
    },
  };
  assert.equal(shouldUseInstagramStructuredFeedFallback(valid), true);
  assert.equal(shouldUseInstagramStructuredFeedFallback({
    ...valid,
    readiness: {
      ...valid.readiness,
      diagnosis: "dom_contract_mismatch",
      visualHydrationReady: true,
    },
  }), true);
  assert.equal(shouldUseInstagramStructuredFeedFallback({
    ...valid,
    readiness: {
      ...valid.readiness,
      diagnosis: "dom_contract_mismatch",
      visualHydrationReady: false,
    },
  }), false);
  assert.equal(shouldUseInstagramStructuredFeedFallback({ ...valid, source: "x" }), false);
  assert.equal(shouldUseInstagramStructuredFeedFallback({
    ...valid,
    readiness: { ...valid.readiness, selectorCandidateCount: 1 },
  }), false);
  assert.equal(shouldUseInstagramStructuredFeedFallback({
    ...valid,
    readiness: { ...valid.readiness, diagnosis: "selector_mismatch" },
  }), false);
});

test("shared Instagram assessment reaches structured fallback without declaring an empty feed ready", async () => {
  const readiness = assessInstagramFixture();
  const before = JSON.stringify(readiness);
  assert.equal(readiness.state, "selector_mismatch");
  assert.equal(readiness.diagnosis, "feed_state_unverified");
  assert.equal(readiness.recovery, null);
  assert.equal(fallbackAllowed(readiness), true);
  assert.equal(JSON.stringify(readiness), before);

  const captured = await collectFallbackFixture(readiness, [JSON.stringify({ item: instagramItem({
    code: "ReadinessFallback_123", username: "aku.example",
  }) })]);
  const { observation } = captured.result;
  assert.equal(captured.executions, 1);
  assert.equal(captured.result.diagnostics.candidateCount, 1);
  assert.equal(observation.coverage.captureQuality.verdict, "usable_degraded");
  assert.equal(observation.snapshots[0].blocks[0].platformId, "instagram:reel:ReadinessFallback_123");

  const empty = await collectFallbackFixture(readiness, []);
  assert.equal(empty.executions, 1);
  assert.equal(empty.result.observation, null);
  assert.equal(empty.result.diagnostics.outcome, "no_candidates");
  assert.equal(readiness.state, "selector_mismatch");
});

test("assessment-to-fallback preserves access, loading and candidate blockers", async (t) => {
  const fixtures = [
    { name: "login", input: { loginRequired: true }, state: "login_required" },
    { name: "challenge", input: { availability: { state: "challenge_required" } }, state: "challenge_required" },
    { name: "unavailable", input: { availability: { state: "source_unavailable" } }, state: "source_unavailable" },
    { name: "wrong page", input: { availability: { state: "wrong_page" } }, state: "wrong_page" },
    { name: "loading indicator", input: { loadingIndicator: true }, state: "loading" },
    { name: "incomplete document", input: { documentReadyState: "interactive" }, state: "loading" },
    { name: "missing feed", input: { feedRootPresent: false }, state: "page_shell" },
    { name: "unhydrated post", input: { structuralCandidateCount: 1 }, state: "feed_hydrating" },
    { name: "offscreen post", input: { selectorCandidateCount: 1 }, state: "feed_not_visible" },
    { name: "ready post", input: { selectorCandidateCount: 1, visibleSelectorCandidateCount: 1 }, state: "feed_ready" },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    const readiness = assessInstagramFixture(fixture.input);
    assert.equal(readiness.state, fixture.state);
    assert.equal(fallbackAllowed(readiness), false);
    const captured = await collectFallbackFixture(readiness, [JSON.stringify({ item: instagramItem({
      code: "BlockedEvidence_123", username: "aku.example",
    }) })]);
    assert.equal(captured.executions, 0);
    assert.equal(captured.result, null);
  });
});

test("unverified fallback requires complete passive evidence and cannot override stale blocker states", () => {
  const readiness = assessInstagramFixture();
  for (const patch of [
    { state: undefined }, { loadingIndicator: undefined }, { documentReadyState: undefined },
    { selectorCandidateCount: undefined }, { structuralCandidateCount: undefined },
    { feedRootPresent: false }, { state: "login_required" }, { state: "loading" },
  ]) assert.equal(fallbackAllowed({ ...readiness, ...patch }), false, JSON.stringify(patch));
  assert.equal(fallbackAllowed(readiness, { source: "x" }), false);
  assert.equal(fallbackAllowed(readiness, { configuredFallback: undefined }), false);

  for (const diagnosis of ["feed_state_unverified", "feed_shell_unhydrated", "dom_contract_mismatch"]) {
    for (const patch of [
      { state: "login_required" }, { state: "challenge_required" }, { state: "source_unavailable" },
      { state: "wrong_page" }, { state: "loading" }, { state: "feed_hydrating" },
      { loadingIndicator: true }, { documentReadyState: "loading" },
    ]) assert.equal(fallbackAllowed({ ...readiness, diagnosis, ...patch }), false, `${diagnosis}: ${JSON.stringify(patch)}`);
  }
});

function assessInstagramFixture(overrides = {}) {
  const context = vm.createContext({ URL });
  for (const file of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/instagram-adapter.js"]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  const sample = {
    feedRootPresent: true, documentReadyState: "complete", loadingIndicator: false,
    selectorCandidateCount: 0, structuralCandidateCount: 0, visibleSelectorCandidateCount: 0,
    visualHydrationRequired: false, visualHydrationReady: true,
    ...overrides,
  };
  const state = context.AkuCapturePrimitives.sourceReadinessState({
    availability: sample.availability, loginRequired: sample.loginRequired,
    visibleCandidateCount: sample.visibleSelectorCandidateCount,
    candidateCount: sample.selectorCandidateCount, structuralCandidateCount: sample.structuralCandidateCount,
    feedRootPresent: sample.feedRootPresent, loading: sample.loadingIndicator,
    documentReady: sample.documentReadyState === "complete",
  });
  return { ...sample, ...context.AkuSourceAdapters.assessReadiness("instagram", { ...sample, state }) };
}

function fallbackAllowed(readiness, overrides = {}) {
  return shouldUseInstagramStructuredFeedFallback({
    source: "instagram", configuredFallback: sourceDefinition("instagram").captureFallback.emptyShell,
    readiness, ...overrides,
  });
}

async function collectFallbackFixture(readiness, scripts) {
  const worker = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const start = worker.indexOf("async function collectStructuredFeedFallback(");
  const end = worker.indexOf("\nfunction isSourceCaptureReady(", start);
  assert.ok(start >= 0 && end > start);
  let executions = 0;
  const context = vm.createContext({
    sourceDefinition, shouldUseInstagramStructuredFeedFallback,
    resolveInstagramStructuredFeedInMainWorld, instagramStructuredFeedObservation,
    chrome: { scripting: { async executeScript(request) {
      executions += 1;
      assert.equal(request.world, "MAIN");
      assert.equal(request.target.tabId, 42);
      return [{ result: withScripts(scripts, () => request.func(...request.args)) }];
    } } },
  });
  vm.runInContext(worker.slice(start, end), context, { filename: "service-worker.js" });
  const result = await context.collectStructuredFeedFallback(42, "instagram", readiness);
  return { result, executions };
}

test("Instagram structured feed resolver returns bounded native post evidence", () => {
  const organic = instagramItem({ code: "ColdStart_123", username: "aku.example" });
  const promoted = instagramItem({ code: "Ad_123", username: "sponsor", productType: "ad" });
  const result = withScripts([JSON.stringify({ items: [organic, promoted] })], () =>
    resolveInstagramStructuredFeedInMainWorld({ maxCandidates: 5 }));

  assert.equal(result.resolverVersion, "instagram-structured-feed-v1");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.rejectedPromotedCount, 1);
  assert.deepEqual(result.candidates[0], {
    candidateId: "instagram:post:ColdStart_123",
    platformId: "instagram:reel:ColdStart_123",
    permalink: "https://www.instagram.com/reel/ColdStart_123/",
    author: "aku.example",
    avatarUrl: "https://instagram.example.fbcdn.net/avatar.jpg?token=avatar",
    text: "Bounded caption from the signed-in Instagram home feed.",
    publishedAt: "2026-08-13T04:00:00.000Z",
    contentKind: "video",
    engagement: { like: "120", comment: "7" },
    media: [{
      kind: "video",
      url: "https://instagram.example.fbcdn.net/poster.jpg?token=poster",
      posterUrl: "https://instagram.example.fbcdn.net/poster.jpg?token=poster",
      playbackUrl: "https://instagram.example.fbcdn.net/video.mp4?token=video",
      playbackMode: "inline",
      width: 720,
      height: 1280,
      provenance: "instagram_structured_feed_json",
    }],
  });
});

test("Instagram structured feed resolver keeps image carousel source order through slide seven", () => {
  const item = instagramItem({ code: "CarouselFeed_123", username: "aku.example", productType: "carousel_container" });
  item.video_versions = [];
  item.carousel_media = Array.from({ length: 7 }, (_, index) => ({
    image_versions2: { candidates: [{
      width: 1080,
      height: 1350,
      url: `https://instagram.example.fbcdn.net/v/feed-slide-${index + 1}.heic?token=${index + 1}`,
    }] },
  }));

  const result = withScripts([JSON.stringify({ item })], () =>
    resolveInstagramStructuredFeedInMainWorld({ maxMediaPerCandidate: 20 }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].media.length, 7);
  assert.deepEqual(
    result.candidates[0].media.map((value) => value.url),
    item.carousel_media.map((_, index) => `https://instagram.example.fbcdn.net/v/feed-slide-${index + 1}.heic?token=${index + 1}`),
  );
});

test("structured feed observation is admissible but explicitly degraded", () => {
  const evidence = withScripts([JSON.stringify({ item: instagramItem({
    code: "ColdStart_456",
    username: "aku.example",
  }) })], () => resolveInstagramStructuredFeedInMainWorld());
  const observation = instagramStructuredFeedObservation(evidence, {
    capturedAt: "2026-08-13T05:00:00.000Z",
  });

  assert.equal(observation.snapshots.length, 1);
  assert.equal(observation.snapshots[0].blocks.length, 1);
  assert.equal(observation.snapshots[0].blocks[0].feedPosition, 1);
  assert.equal(observation.coverage.captureMethod, "instagram_structured_feed_json");
  assert.equal(observation.coverage.captureQuality.verdict, "usable_degraded");
  assert.equal(observation.coverage.observedBlockCount, 1);
});

test("Instagram structured feed resolver rejects hostile and oversized evidence", () => {
  const hostile = instagramItem({ code: "Unsafe_123", username: "aku.example" });
  hostile.image_versions2.candidates[0].url = "https://attacker.example/poster.jpg";
  hostile.video_versions[0].url = "https://attacker.example/video.mp4";
  hostile.user.profile_pic_url = "https://attacker.example/avatar.jpg";
  const oversized = `${"x".repeat(10_000)}\"image_versions2\"\"code\"`;
  const result = withScripts([JSON.stringify({ item: hostile }), oversized], () =>
    resolveInstagramStructuredFeedInMainWorld({ maxScriptBytes: 8_192 }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].avatarUrl, null);
  assert.deepEqual(result.candidates[0].media, []);
  assert.equal(result.diagnostics.rejectedScriptCount, 1);
  assert.equal(JSON.stringify(result).includes("attacker.example"), false);
});

test("Instagram structured feed resolver reports candidate rejection causes", () => {
  const incomplete = instagramItem({ code: "MissingImage_123", username: "aku.example" });
  incomplete.image_versions2.candidates = [];
  const result = withScripts([JSON.stringify({ item: incomplete })], () =>
    resolveInstagramStructuredFeedInMainWorld());

  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.candidateRejectionCounts.missing_image_versions, 1);
});

test("Instagram structured feed fallback accepts the observed 300 KB bootstrap payload safely", () => {
  const payload = JSON.stringify({
    padding: "x".repeat(310_000),
    item: instagramItem({ code: "LargeBootstrap_123", username: "aku.example" }),
  });
  const accepted = withScripts([payload], () => resolveInstagramStructuredFeedInMainWorld({
    maxScriptBytes: 512_000,
  }));

  assert.equal(payload.length > 300_000, true);
  assert.equal(accepted.candidates.length, 1);
  assert.equal(accepted.diagnostics.largestMatchedScriptBytes, payload.length);
  assert.equal(accepted.diagnostics.oversizedScriptCount, 0);
  assert.deepEqual(accepted.diagnostics.boundedReasons, []);

  const rejected = withScripts([payload], () => resolveInstagramStructuredFeedInMainWorld({
    maxScriptBytes: 300_000,
  }));
  assert.equal(rejected.candidates.length, 0);
  assert.equal(rejected.diagnostics.oversizedScriptCount, 1);
  assert.equal(rejected.diagnostics.bounded, true);
  assert.deepEqual(rejected.diagnostics.boundedReasons, ["max_script_bytes"]);
});

function instagramItem({ code, username, productType = "clips" }) {
  return {
    code,
    user: {
      username,
      profile_pic_url: "https://instagram.example.fbcdn.net/avatar.jpg?token=avatar",
    },
    caption: { text: "Bounded caption from the signed-in Instagram home feed." },
    product_type: productType,
    media_type: 2,
    taken_at: Date.parse("2026-08-13T04:00:00.000Z") / 1_000,
    like_count: 120,
    comment_count: 7,
    sponsor_tags: [],
    image_versions2: { candidates: [{
      width: 640,
      height: 1136,
      url: "https://instagram.example.fbcdn.net/poster.jpg?token=poster",
    }] },
    video_versions: [{
      width: 720,
      height: 1280,
      url: "https://instagram.example.fbcdn.net/video.mp4?token=video",
    }],
  };
}

function withScripts(texts, callback) {
  const previous = globalThis.document;
  const nodes = texts.map((textContent) => ({ textContent }));
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === 'script[type="application/json"]' || selector === "script:not([src])"
        ? nodes
        : [];
    },
  };
  try { return callback(); }
  finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}
