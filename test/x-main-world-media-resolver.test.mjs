import test from "node:test";
import assert from "node:assert/strict";
import { resolveXStructuredMediaInMainWorld } from "../x-main-world-media-resolver.js";

test("MAIN-world resolver returns only structured media for the owning X candidate", () => {
  const article = syntheticArticle("12345", {
    tweet_results: {
      result: {
        rest_id: "12345",
        legacy: {
          full_text: "This must not cross the world boundary",
          extended_entities: {
            media: [{
              type: "photo",
              media_url_https: "https://pbs.twimg.com/media/example.jpg?format=jpg&name=large",
              original_info: { width: 1600, height: 900 },
            }],
          },
        },
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld());

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidateId, "x:status:12345");
  assert.deepEqual(result.candidates[0].media, [{
    kind: "image",
    url: "https://pbs.twimg.com/media/example.jpg?format=jpg&name=large",
    posterUrl: "https://pbs.twimg.com/media/example.jpg?format=jpg&name=large",
    playbackUrl: null,
    playbackMode: null,
    width: 1600,
    height: 900,
    provenance: "main_structured_state",
  }]);
  assert.equal(JSON.stringify(result).includes("must not cross"), false);
});

test("MAIN-world resolver pairs an X video poster with an allowlisted playback URL", () => {
  const article = syntheticArticle("23456", {
    result: {
      rest_id: "23456",
      legacy: {
        extended_entities: {
          media: [{
            type: "video",
            media_url_https:
              "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg",
            original_info: { width: 1280, height: 720 },
            video_info: {
              variants: [{
                content_type: "video/mp4",
                url: "https://video.twimg.com/ext_tw_video/23456/pu/vid/avc1/clip.mp4?tag=12",
              }],
            },
          }],
        },
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld());
  assert.equal(result.candidates[0].media.length, 1);
  assert.deepEqual(result.candidates[0].media[0], {
    kind: "video",
    url: "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg",
    posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg",
    playbackUrl: "https://video.twimg.com/ext_tw_video/23456/pu/vid/avc1/clip.mp4?tag=12",
    playbackMode: "inline",
    width: 1280,
    height: 720,
    provenance: "main_structured_state",
  });
});

test("MAIN-world resolver honors candidate filtering and rejects non-X media hosts", () => {
  const allowed = syntheticArticle("34567", {
    result: {
      rest_id: "34567",
      media_url_https: "https://pbs.twimg.com/media/allowed.jpg",
    },
  });
  const filtered = syntheticArticle("45678", {
    result: {
      rest_id: "45678",
      media_url_https: "https://pbs.twimg.com/media/filtered.jpg",
      tracking_url: "https://collector.example/private",
    },
  });
  const result = withDocument([allowed, filtered], () => resolveXStructuredMediaInMainWorld({
    candidateIds: ["x:status:34567"],
  }));

  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), ["x:status:34567"]);
  assert.equal(JSON.stringify(result).includes("collector.example"), false);
  assert.equal(JSON.stringify(result).includes("filtered.jpg"), false);
});

test("MAIN-world resolver does not attribute quoted Tweet media to the owning candidate", () => {
  const article = syntheticArticle("34567", {
    result: {
      rest_id: "34567",
      legacy: { full_text: "Owning post without media" },
      quoted_status_result: {
        result: {
          __typename: "Tweet",
          rest_id: "99999",
          legacy: {
            full_text: "Quoted post",
            extended_entities: {
              media: [{
                media_url_https: "https://pbs.twimg.com/media/quoted.jpg",
                original_info: { width: 1200, height: 800 },
              }],
            },
          },
        },
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld());

  assert.equal(result.candidates.length, 0);
  assert.equal(JSON.stringify(result).includes("quoted.jpg"), false);
});

test("MAIN-world resolver is cycle-safe, getter-safe, and traversal-bounded", () => {
  const structured = { rest_id: "56789" };
  structured.self = structured;
  Object.defineProperty(structured, "dangerous_url", {
    enumerable: true,
    get() {
      throw new Error("getter must not execute");
    },
  });
  let current = structured;
  for (let index = 0; index < 500; index += 1) {
    current.next = { index };
    current = current.next;
  }
  const article = syntheticArticle("56789", { result: structured });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    maxTraversalNodes: 100,
    maxDepth: 12,
  }));

  assert.equal(result.diagnostics.traversedNodeCount <= 100, true);
  assert.equal(result.candidates.length, 0);
});

function syntheticArticle(candidateId, structuredState) {
  const anchor = {
    href: `https://x.com/author/status/${candidateId}`,
    getAttribute: () => `/author/status/${candidateId}`,
    closest: (selector) => selector.includes("quoteTweet") ? null : null,
  };
  const time = {
    closest: (selector) => selector.includes('a[href*="/status/"]') ? anchor : null,
  };
  const article = {
    querySelectorAll(selector) {
      if (selector === "time") return [time];
      if (selector.includes('a[href*="/status/"]')) return [anchor];
      return [];
    },
  };
  article.__reactProps$aku = structuredState;
  return article;
}

function withDocument(articles, callback) {
  const previous = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === 'article[data-testid="tweet"]' ? articles : [];
    },
  };
  try {
    return callback();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}
