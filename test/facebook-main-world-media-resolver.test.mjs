import test from "node:test";
import assert from "node:assert/strict";
import { resolveFacebookStructuredMediaInMainWorld } from "../facebook-main-world-media-resolver.js";

test("Facebook MAIN-world resolver returns one bounded progressive video for its owning post", () => {
  const payload = facebookPayload({
    id: "1406142818042755",
    permalink: "https://www.facebook.com/reel/1406142818042755/",
    poster: "https://scontent.example.fbcdn.net/v/t15.5256-10/poster.jpg?oh=poster",
    progressive: [
      "https://scontent.example.fbcdn.net/o1/v/t2/f2/low.mp4?oe=ABC",
      "https://scontent.example.fbcdn.net/o1/v/t2/f2/high.mp4?oe=ABC",
    ],
  });

  const result = withScripts([payload], () => resolveFacebookStructuredMediaInMainWorld());

  assert.equal(result.resolverVersion, "facebook-structured-video-v1");
  assert.deepEqual(result.candidates, [{
    candidateId: "facebook:post:1406142818042755",
    media: [{
      kind: "video",
      url: "https://scontent.example.fbcdn.net/v/t15.5256-10/poster.jpg?oh=poster",
      posterUrl: "https://scontent.example.fbcdn.net/v/t15.5256-10/poster.jpg?oh=poster",
      playbackUrl: "https://scontent.example.fbcdn.net/o1/v/t2/f2/high.mp4?oe=ABC",
      playbackMode: "inline",
      width: 1920,
      height: 1080,
      provenance: "facebook_structured_json",
    }],
  }]);
  assert.equal(JSON.stringify(result).includes("post text must stay private"), false);
});

test("Facebook resolver filters requested candidates and rejects non-Facebook media", () => {
  const allowed = facebookPayload({
    id: "1234567890",
    permalink: "https://www.facebook.com/reel/1234567890/",
    poster: "https://scontent.example.fbcdn.net/v/poster.jpg",
    progressive: ["https://scontent.example.fbcdn.net/o1/allowed.mp4?oe=ABC"],
  });
  const rejected = facebookPayload({
    id: "9876543210",
    permalink: "https://www.facebook.com/reel/9876543210/",
    poster: "https://attacker.example/poster.jpg",
    progressive: ["https://attacker.example/video.mp4"],
  });

  const result = withScripts([allowed, rejected], () => resolveFacebookStructuredMediaInMainWorld({
    candidateIds: ["facebook:post:1234567890"],
  }));

  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), [
    "facebook:post:1234567890",
  ]);
  assert.equal(JSON.stringify(result).includes("attacker.example"), false);
});

test("Facebook resolver rejects oversized scripts and remains traversal bounded", () => {
  const oversized = `${"x".repeat(10_000)}progressive_urls`;
  const result = withScripts([oversized], () => resolveFacebookStructuredMediaInMainWorld({
    maxScriptBytes: 8_192,
    maxTraversalNodes: 500,
  }));

  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.rejectedScriptCount, 1);
  assert.equal(result.diagnostics.traversedNodeCount <= 500, true);
});

function facebookPayload({ id, permalink, poster, progressive }) {
  return JSON.stringify({
    require: [{
      __bbox: {
        result: {
          data: {
            node: {
              attachments: [{
                media: {
                  __typename: "Video",
                  id,
                  permalink_url: permalink,
                  first_frame_thumbnail: poster,
                  width: 1920,
                  height: 1080,
                  private_text: "post text must stay private",
                  videoDeliveryResponseFragment: {
                    videoDeliveryResponseResult: {
                      id,
                      progressive_urls: progressive.map((progressive_url) => ({ progressive_url })),
                    },
                  },
                },
              }],
            },
          },
        },
      },
    }],
  });
}

function withScripts(texts, callback) {
  const previous = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector !== 'script[type="application/json"][data-sjs]') return [];
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
