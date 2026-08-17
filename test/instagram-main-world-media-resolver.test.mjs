import test from "node:test";
import assert from "node:assert/strict";
import { resolveInstagramStructuredMediaInMainWorld } from "../instagram-main-world-media-resolver.js";

test("Instagram MAIN-world resolver returns bounded MP4 and poster evidence by shortcode", () => {
  const payload = instagramPayload({
    code: "Db8U_yQiijk",
    videos: [
      { width: 480, height: 852, url: "https://instagram.example.fbcdn.net/o1/low.mp4?token=low" },
      { width: 720, height: 1280, url: "https://instagram.example.fbcdn.net/o1/high.mp4?token=high" },
    ],
    posters: [
      { width: 320, height: 568, url: "https://instagram.example.fbcdn.net/v/poster-small.jpg?token=small" },
      { width: 640, height: 1136, url: "https://instagram.example.fbcdn.net/v/poster-large.jpg?token=large" },
    ],
  });

  const result = withScripts([payload], () => resolveInstagramStructuredMediaInMainWorld());

  assert.equal(result.resolverVersion, "instagram-structured-carousel-v2");
  assert.deepEqual(result.candidates, [{
    candidateId: "instagram:post:Db8U_yQiijk",
    media: [{
      kind: "video",
      url: "https://instagram.example.fbcdn.net/v/poster-large.jpg?token=large",
      posterUrl: "https://instagram.example.fbcdn.net/v/poster-large.jpg?token=large",
      playbackUrl: "https://instagram.example.fbcdn.net/o1/high.mp4?token=high",
      playbackMode: "inline",
      width: 720,
      height: 1280,
      provenance: "instagram_structured_json",
    }],
  }]);
  assert.equal(JSON.stringify(result).includes("private caption must stay private"), false);
});

test("Instagram resolver matches p and reel identities to the same shortcode and supports carousel video", () => {
  const payload = JSON.stringify({
    item: {
      code: "Carousel_123",
      carousel_media: [{
        video_versions: [{
          width: 1080,
          height: 1080,
          url: "https://scontent.cdninstagram.com/o1/carousel.mp4?token=video",
        }],
        image_versions2: { candidates: [{
          width: 1080,
          height: 1080,
          url: "https://scontent.cdninstagram.com/v/carousel.webp?token=poster",
        }] },
      }],
    },
  });

  const result = withScripts([payload], () => resolveInstagramStructuredMediaInMainWorld({
    candidateIds: ["https://www.instagram.com/reel/Carousel_123/"],
  }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidateId, "instagram:post:Carousel_123");
  assert.equal(result.candidates[0].media[0].playbackMode, "inline");
});

test("Instagram resolver preserves an image-only carousel beyond the former four-slide limit", () => {
  const carousel = Array.from({ length: 7 }, (_, index) => ({
    image_versions2: { candidates: [{
      width: 1080,
      height: 1350,
      url: `https://instagram.example.fbcdn.net/v/carousel-${index + 1}.heic?token=${index + 1}`,
    }] },
  }));
  const payload = JSON.stringify({ item: { code: "Carousel_Images_123", carousel_media: carousel } });

  const result = withScripts([payload], () => resolveInstagramStructuredMediaInMainWorld({
    maxMediaPerCandidate: 20,
  }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].media.length, 7);
  assert.deepEqual(
    result.candidates[0].media.map((value) => value.url),
    carousel.map((value, index) => `https://instagram.example.fbcdn.net/v/carousel-${index + 1}.heic?token=${index + 1}`),
  );
  assert.equal(result.candidates[0].media.every((value) => value.kind === "image"), true);
});

test("Instagram resolver rejects hostile media and oversized JSON", () => {
  const hostile = instagramPayload({
    code: "Unsafe_123",
    videos: [{ width: 720, height: 1280, url: "https://attacker.example/video.mp4" }],
    posters: [{ width: 640, height: 1136, url: "https://attacker.example/poster.jpg" }],
  });
  const oversized = `${"x".repeat(10_000)}image_versions2`;

  const result = withScripts([hostile, oversized], () => resolveInstagramStructuredMediaInMainWorld({
    maxScriptBytes: 8_192,
    maxTraversalNodes: 500,
  }));

  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.rejectedScriptCount, 1);
  assert.equal(result.diagnostics.traversedNodeCount <= 500, true);
  assert.equal(JSON.stringify(result).includes("attacker.example"), false);
});

function instagramPayload({ code, videos, posters }) {
  return JSON.stringify({
    require: [{
      data: {
        item: {
          code,
          media_type: 2,
          product_type: "clips",
          video_versions: videos,
          image_versions2: { candidates: posters },
          caption: { text: "private caption must stay private" },
        },
      },
    }],
  });
}

function withScripts(texts, callback) {
  const previous = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector !== 'script[type="application/json"]') return [];
      return texts.map((textContent) => ({ textContent }));
    },
  };
  try {
    return callback();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}
