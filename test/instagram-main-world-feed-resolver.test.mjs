import test from "node:test";
import assert from "node:assert/strict";
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
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === 'script[type="application/json"]'
        ? texts.map((textContent) => ({ textContent }))
        : [];
    },
  };
  try { return callback(); }
  finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}
