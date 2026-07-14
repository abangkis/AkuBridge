import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadPolicy() {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "bounded-capture-policy.js"), "utf8"),
    context,
  );
  return context.AkuBoundedCapturePolicy;
}

test("native capture policy clamps every browser-movement budget", () => {
  const policy = loadPolicy();
  const plan = policy.normalizeCapturePlan({
    source: "x",
    scrolls: 99,
    scrollFraction: 0.1,
    scrollSettleMs: 99_999,
    captureTimeoutMs: 99_999,
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: true,
    pendingContentTimeoutMs: 99_999,
    pendingContentSettleMs: 99_999,
    maxBlocksPerSnapshot: 99,
    maxBlockCharacters: 99_999,
    restoreScroll: false,
  });

  assert.equal(plan.scrolls, 2);
  assert.equal(plan.scrollFraction, 0.5);
  assert.equal(plan.scrollSettleMs, 2_000);
  assert.equal(plan.captureTimeoutMs, 45_000);
  assert.equal(plan.pendingContentPolicy, "reveal_if_present");
  assert.equal(plan.sameTabMutationAllowed, true);
  assert.equal(plan.pendingContentTimeoutMs, 5_000);
  assert.equal(plan.pendingContentSettleMs, 2_000);
  assert.equal(plan.maxBlocksPerSnapshot, 20);
  assert.equal(plan.maxBlockCharacters, 4_000);
  assert.equal(plan.restoreScroll, true);
  assert.equal(Object.isFrozen(plan), true);
});

test("fresh-content reveal fails closed without explicit same-tab mutation authority", () => {
  const policy = loadPolicy();
  const plan = policy.normalizeCapturePlan({
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: false,
  });

  assert.equal(plan.pendingContentPolicy, "detect_only");
  assert.equal(plan.sameTabMutationAllowed, false);
});

test("fresh-content readiness requires a changed non-empty visible feed", () => {
  const policy = loadPolicy();

  assert.equal(policy.hasChangedVisibleFeed("old post", ""), false);
  assert.equal(policy.hasChangedVisibleFeed("old post", "old post"), false);
  assert.equal(policy.hasChangedVisibleFeed("", "new post"), false);
  assert.equal(policy.hasChangedVisibleFeed("old post", "new post"), true);
});

test("Gate 0B.3 continuation is accepted only in round two and remains bounded", () => {
  const policy = loadPolicy();
  const continuation = {
    startScrollY: 1_350.8,
    anchorKeys: [" first ", "second", "third", "fourth"],
    settleMs: 99_999,
  };

  const initial = policy.normalizeCapturePlan({
    acquisitionRound: 1,
    continuation,
  });
  assert.equal(initial.continuation, null);

  const followUp = policy.normalizeCapturePlan({
    acquisitionRound: 2,
    continuation,
    pendingContentPolicy: "reveal_if_present",
    sameTabMutationAllowed: true,
  });
  assert.equal(followUp.acquisitionRound, 2);
  assert.equal(followUp.continuation.startScrollY, 1_350);
  assert.deepEqual([...followUp.continuation.anchorKeys], ["first", "second", "third"]);
  assert.equal(followUp.continuation.settleMs, 2_000);
  assert.equal(followUp.pendingContentPolicy, "detect_only");
  assert.equal(followUp.sameTabMutationAllowed, false);
});

test("candidate accounting collapses repeated posts across snapshots", () => {
  const policy = loadPolicy();
  const seen = new Set();

  assert.equal(
    policy.countNewCandidates(
      [
        { text: "First post", permalink: "https://x.com/example/status/1" },
        { text: "Second post", permalink: null },
      ],
      seen,
    ),
    2,
  );
  assert.equal(
    policy.countNewCandidates(
      [
        { text: "First post repeated", permalink: "https://x.com/example/status/1" },
        { text: "  second   post ", permalink: null },
        { text: "Third post", permalink: "https://x.com/example/status/3" },
      ],
      seen,
    ),
    1,
  );
});

test("platform identity normalizes X status and LinkedIn activity variants", () => {
  const policy = loadPolicy();
  assert.equal(
    policy.platformIdFromCandidates("x", ["https://x.com/openai/status/2075000000000000000"]),
    "x:status:2075000000000000000",
  );
  assert.equal(
    policy.platformIdFromCandidates("linkedin", ["urn:li:activity:7412345678901234567"]),
    "linkedin:activity:7412345678901234567",
  );
  assert.equal(
    policy.platformIdFromCandidates("linkedin", ["urn:li:ugcPost:7412345678901234568"]),
    "linkedin:ugcpost:7412345678901234568",
  );
  assert.equal(policy.platformIdFromCandidates("linkedin", ["unrelated"]), null);
});

test("captured media is bounded to rendered source CDN images", () => {
  const policy = loadPolicy();
  const xMedia = policy.normalizeMediaCandidates("x", [
    { url: "https://pbs.twimg.com/media/example.jpg#fragment", alt: "Diagram", width: 640, height: 360 },
    { url: "https://evil.example/tracker.png", width: 640, height: 360 },
    { url: "https://pbs.twimg.com/profile_images/avatar.jpg", width: 48, height: 48 },
    { url: "https://pbs.twimg.com/media/example.jpg", width: 640, height: 360 },
  ]);
  assert.equal(xMedia.length, 1);
  assert.equal(xMedia[0].url, "https://pbs.twimg.com/media/example.jpg");
  assert.equal(xMedia[0].kind, "image");

  const linkedInMedia = policy.normalizeMediaCandidates("linkedin", [
    { url: "https://media.licdn.com/dms/image/example", kind: "video_poster", width: 800, height: 450 },
  ]);
  assert.equal(linkedInMedia.length, 1);
  assert.equal(linkedInMedia[0].kind, "video");
  assert.equal(linkedInMedia[0].posterUrl, "https://media.licdn.com/dms/image/example");
  assert.equal(linkedInMedia[0].playbackMode, "native");
  assert.equal(Object.isFrozen(linkedInMedia), true);
});

test("X video thumbnails can be extracted from a bounded CSS background", () => {
  const policy = loadPolicy();
  assert.equal(
    policy.mediaUrlFromCssBackground('url("https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/frame.jpg")'),
    "https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/frame.jpg",
  );
  assert.equal(policy.mediaUrlFromCssBackground("none"), null);
  assert.equal(policy.mediaUrlFromCssBackground('linear-gradient(red, blue)'), null);
  const media = policy.normalizeMediaCandidates("x", [{
    kind: "video",
    url: policy.mediaUrlFromCssBackground(
      'url("https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/frame.jpg")',
    ),
    width: 640,
    height: 360,
  }]);
  assert.equal(media[0].kind, "video");
  assert.equal(media[0].playbackMode, "native");
});

test("X photo backgrounds remain images when lazy img hydration is incomplete", () => {
  const policy = loadPolicy();
  const media = policy.normalizeMediaCandidates("x", [{
    kind: "image",
    url: policy.mediaUrlFromCssBackground(
      'url("https://pbs.twimg.com/media/HNCOdOsacAI0xrI?format=png&name=small")',
    ),
    width: 680,
    height: 513,
  }]);
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "image");
  assert.equal(media[0].posterUrl, null);
  assert.equal(media[0].playbackMode, null);
});

test("X link-card previews remain bounded presentation images", () => {
  const policy = loadPolicy();
  const media = policy.normalizeMediaCandidates("x", [{
    kind: "image",
    url: policy.mediaUrlFromCssBackground(
      'url("https://pbs.twimg.com/card_img/2075272070611533824/V_6gmE5E?format=jpg&name=small")',
    ),
    alt: "openai.com OpenAI Build Week",
    width: 564,
    height: 295,
  }]);
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "image");
  assert.match(media[0].url, /pbs\.twimg\.com\/card_img\//);
  assert.equal(media[0].alt, "openai.com OpenAI Build Week");
});

test("X video playback remains inline only for an allowlisted stable CDN URL", () => {
  const policy = loadPolicy();
  const inline = policy.normalizeMediaCandidates("x", [{
    kind: "video",
    posterUrl: "https://pbs.twimg.com/amplify_video_thumb/example/img/frame.jpg",
    playbackUrl: "https://video.twimg.com/amplify_video/example/vid/avc1/1280x720/clip.mp4",
    playbackMode: "inline",
    width: 640,
    height: 360,
  }]);
  assert.equal(inline[0].playbackMode, "inline");
  assert.match(inline[0].playbackUrl, /^https:\/\/video\.twimg\.com\//);

  const native = policy.normalizeMediaCandidates("x", [{
    kind: "video",
    posterUrl: "https://pbs.twimg.com/amplify_video_thumb/example/img/frame.jpg",
    playbackUrl: "blob:https://x.com/fixture",
    playbackMode: "inline",
    width: 640,
    height: 360,
  }]);
  assert.equal(native[0].playbackUrl, null);
  assert.equal(native[0].playbackMode, "native");
});

test("the policy is loaded before the source content script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const sourceEntry = manifest.content_scripts.find((entry) =>
    entry.matches.includes("https://x.com/*"),
  );
  assert.deepEqual(sourceEntry.js, [
    "bounded-capture-policy.js",
    "capture-quality-policy.js",
    "linkedin-permalink-policy.js",
    "linkedin-timestamp-policy.js",
    "source-adapter-runtime.js",
    "adapters/x-adapter.js",
    "adapters/linkedin-adapter.js",
    "source-freshness-runtime.js",
    "media-recovery-runtime.js",
    "content-script.js",
  ]);

  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert.match(worker, /const SOURCE_SCRIPT_FILES = \[/);
  assert.match(worker, /"capture-quality-policy\.js"/);
  assert.match(worker, /"linkedin-permalink-policy\.js"/);
  assert.match(worker, /"linkedin-timestamp-policy\.js"/);
  assert.match(worker, /"adapters\/x-adapter\.js"/);
  assert.match(worker, /"adapters\/linkedin-adapter\.js"/);
  assert.match(worker, /"source-freshness-runtime\.js"/);
  assert.match(worker, /"media-recovery-runtime\.js"/);
});
