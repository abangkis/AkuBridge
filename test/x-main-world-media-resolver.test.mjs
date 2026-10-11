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
  const mp4Result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    maxTraversalNodes: 100,
    maxDepth: 12,
    playbackFormat: "mp4",
  }));

  assert.equal(result.diagnostics.traversedNodeCount <= 100, true);
  assert.equal(result.candidates.length, 0);
  assert.equal(mp4Result.candidates.length, 0);
});

test("explicit deeper traversal resolves own media while preserving Bridge defaults and the depth cap", () => {
  const nest = (value, depth) => { for (let i=0;i<depth;i++) value={next:value}; return value; };
  const own={__typename:"Tweet",rest_id:"23456",legacy:{full_text:"Own",extended_entities:{media:[{
    media_url_https:"https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg",
    video_info:{variants:[{url:"https://video.twimg.com/ext_tw_video/23456/pu/vid/clip.mp4"}]},
  }]}},quoted_status_result:{result:{__typename:"Tweet",rest_id:"99999",legacy:{full_text:"Quote",
    extended_entities:{media:[{media_url_https:"https://pbs.twimg.com/media/foreign.jpg"}]}}}}};
  const article=syntheticArticle("23456",nest(own,13));
  const run=request=>withDocument([article],()=>resolveXStructuredMediaInMainWorld(request));
  assert.equal(run({}).candidates.length,0);
  assert.equal(run({maxDepth:12}).candidates.length,0);
  const result=run({maxDepth:16,maxTraversalNodes:1500});
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].media[0].kind,"video");
  assert.equal(JSON.stringify(result).includes("foreign.jpg"),false);
  assert.ok(result.diagnostics.traversedNodeCount<=1500);
  const tooDeep=syntheticArticle("23456",nest(own,17));
  assert.equal(withDocument([tooDeep],()=>resolveXStructuredMediaInMainWorld({maxDepth:999})).candidates.length,0);
});

test("MP4 preference pairs matching assets, prefers available resolution, and leaves legacy HLS behavior unchanged", () => {
  const poster="https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg";
  const hls="https://video.twimg.com/ext_tw_video/23456/pu/pl/master.m3u8";
  const low="https://video.twimg.com/ext_tw_video/23456/pu/vid/320x180/low.mp4";
  const high="https://video.twimg.com/ext_tw_video/23456/pu/vid/1280x720/high.mp4";
  const other="https://video.twimg.com/ext_tw_video/99999/pu/vid/1920x1080/foreign.mp4";
  const article=syntheticArticle("23456",{rest_id:"23456",media_url_https:poster,
    variants:[{url:hls},{url:other},{url:low},{url:high}]});
  const run=request=>withDocument([article],()=>resolveXStructuredMediaInMainWorld(request));
  assert.equal(run({maxMediaPerCandidate:8}).candidates[0].media.find(m=>m.posterUrl===poster).playbackUrl,hls);
  assert.equal(run({maxMediaPerCandidate:8,playbackFormat:"mp4"}).candidates[0].media.find(m=>m.posterUrl===poster).playbackUrl,high);
  const unmatched=syntheticArticle("23456",{rest_id:"23456",media_url_https:poster,variants:[{url:hls},{url:other}]});
  const unresolved=withDocument([unmatched],()=>resolveXStructuredMediaInMainWorld({playbackFormat:"mp4"}));
  assert.equal(unresolved.candidates[0].media.find(m=>m.posterUrl===poster).playbackUrl,null);
});

test("MP4 extraction finds a later own poster pair without spending the output limit on earlier media or variants", () => {
  const poster = "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg";
  const high = "https://video.twimg.com/ext_tw_video/23456/pu/vid/1280x720/high.mp4";
  const article = syntheticArticle("23456", {
    rest_id: "23456",
    media: [
      { media_url_https: "https://pbs.twimg.com/media/first.jpg" },
      { media_url_https: "https://pbs.twimg.com/media/second.jpg" },
      {
        media_url_https: poster,
        video_info: {
          variants: [
            { url: "https://video.twimg.com/ext_tw_video/23456/pu/pl/master.m3u8" },
            { url: "https://video.twimg.com/ext_tw_video/99999/pu/vid/1920x1080/foreign.mp4" },
            { url: "https://video.twimg.com/ext_tw_video/23456/pu/vid/320x180/low.mp4" },
            { url: high },
          ],
        },
      },
    ],
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    maxMediaPerCandidate: 1,
    playbackFormat: "mp4",
  }));

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].media.map(({ kind, posterUrl, playbackUrl }) => ({
    kind, posterUrl, playbackUrl,
  })), [{ kind: "video", posterUrl: poster, playbackUrl: high }]);
});

test("MP4 extraction cannot borrow a matching variant from a quoted Tweet", () => {
  const poster = "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg";
  const quotedPlayback = "https://video.twimg.com/ext_tw_video/23456/pu/vid/1280x720/quoted.mp4";
  const article = syntheticArticle("23456", {
    __typename: "Tweet",
    rest_id: "23456",
    legacy: {
      full_text: "Owning post",
      extended_entities: {
        media: [{ media_url_https: poster }],
      },
    },
    quoted_status_result: {
      result: {
        __typename: "Tweet",
        rest_id: "99999",
        legacy: {
          full_text: "Quoted post",
          extended_entities: {
            media: [{ video_info: { variants: [{ url: quotedPlayback }] } }],
          },
        },
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    playbackFormat: "mp4",
  }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].media[0].posterUrl, poster);
  assert.equal(result.candidates[0].media[0].playbackUrl, null);
  assert.equal(JSON.stringify(result).includes("quoted.mp4"), false);
});

test("MP4 extraction follows the requested depth cap to find a deeply nested own variant", () => {
  const poster = "https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg";
  const playback = "https://video.twimg.com/ext_tw_video/23456/pu/vid/1280x720/deep.mp4";
  let deepVariant = { url: playback };
  for (let index = 0; index < 9; index += 1) deepVariant = { next: deepVariant };
  const article = syntheticArticle("23456", {
    __typename: "Tweet",
    rest_id: "23456",
    legacy: {
      full_text: "Owning post",
      extended_entities: { media: [{ media_url_https: poster }] },
    },
    nested: deepVariant,
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    maxDepth: 16,
    maxTraversalNodes: 1_500,
    playbackFormat: "mp4",
  }));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].media[0].kind, "video");
  assert.equal(result.candidates[0].media[0].playbackUrl, playback);
});

test("MP4 extraction pairs a generic /media/ poster with the best variant in its own video entity", () => {
  const poster = "https://pbs.twimg.com/media/GlKfj-9W4AAMzDO.jpg?format=jpg&name=large";
  const low = "https://video.twimg.com/amplify_video/asset-a/vid/320x180/low.mp4";
  const high = "https://video.twimg.com/amplify_video/asset-a/vid/1280x720/high.mp4";
  const article = syntheticArticle("67890", {
    rest_id: "67890",
    legacy: {
      extended_entities: {
        media: [
          { type: "photo", media_url_https: "https://pbs.twimg.com/media/earlier-photo.jpg" },
          {
            type: "video",
            media_url_https: poster,
            original_info: { width: 1920, height: 1080 },
            video_info: { variants: [
              { content_type: "video/mp4", url: low },
              { content_type: "application/x-mpegURL", url: "https://video.twimg.com/amplify_video/asset-a/pu/pl/master.m3u8" },
              { content_type: "video/mp4", url: high },
            ] },
          },
        ],
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({
    maxMediaPerCandidate: 1,
    playbackFormat: "mp4",
  }));

  assert.deepEqual(result.candidates[0].media, [{
    kind: "video",
    url: poster,
    posterUrl: poster,
    playbackUrl: high,
    playbackMode: "inline",
    pairing: "same_video_media_entity",
    width: 1920,
    height: 1080,
    provenance: "main_structured_state",
  }]);
});

test("MP4 extraction resolves distinct generic poster entities and animated GIF media", () => {
  const firstPoster = "https://pbs.twimg.com/media/first-generic?format=webp&name=large";
  const secondPoster = "https://pbs.twimg.com/media/second-generic.png";
  const firstPlayback = "https://video.twimg.com/ext_tw_video/video-a/vid/640x360/first.mp4";
  const secondPlayback = "https://video.twimg.com/tweet_video/video-b/vid/1280x720/second.mp4";
  const article = syntheticArticle("67891", {
    rest_id: "67891",
    legacy: {
      extended_entities: {
        media: [
          { type: "video", media_url_https: firstPoster, video_info: { variants: [{ url: firstPlayback }] } },
          { type: "animated_gif", media_url_https: secondPoster, video_info: { variants: [{ url: secondPlayback }] } },
        ],
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));

  assert.deepEqual(result.candidates[0].media.map(({ kind, posterUrl, playbackUrl, pairing }) => ({
    kind, posterUrl, playbackUrl, pairing,
  })), [
    { kind: "video", posterUrl: firstPoster, playbackUrl: firstPlayback, pairing: "same_video_media_entity" },
    { kind: "video", posterUrl: secondPoster, playbackUrl: secondPlayback, pairing: "same_video_media_entity" },
  ]);
});

test("MP4 extraction fails closed when one generic poster maps to conflicting video entities", () => {
  const poster = "https://pbs.twimg.com/media/reused-poster?format=jpg";
  const article = syntheticArticle("67892", {
    rest_id: "67892",
    legacy: {
      extended_entities: {
        media: [
          { type: "video", media_url_https: poster, video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/video-a/vid/640x360/a.mp4" }] } },
          { type: "video", media_url_https: poster, video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/video-b/vid/640x360/b.mp4" }] } },
        ],
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));
  const media = result.candidates[0].media;

  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "image");
  assert.equal(media[0].posterUrl, poster);
  assert.equal(media[0].playbackUrl, null);
  assert.equal("pairing" in media[0], false);
});

test("MP4 extraction does not pair generic posters with image-only, HLS-only, or ambiguous entities", () => {
  const imagePoster = "https://pbs.twimg.com/media/image-only.jpg";
  const hlsPoster = "https://pbs.twimg.com/media/hls-only?format=png";
  const ambiguousPoster = "https://pbs.twimg.com/media/ambiguous?format=avif";
  const article = syntheticArticle("67893", {
    rest_id: "67893",
    legacy: {
      extended_entities: {
        media: [
          { type: "photo", media_url_https: imagePoster, video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/image/vid/640x360/photo.mp4" }] } },
          { type: "video", media_url_https: hlsPoster, video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/hls/pu/pl/master.m3u8" }] } },
          { type: "video", media_url_https: ambiguousPoster, video_info: { variants: [
            { url: "https://video.twimg.com/ext_tw_video/ambiguous-a/vid/640x360/a.mp4" },
            { url: "https://video.twimg.com/ext_tw_video/ambiguous-b/vid/1280x720/b.mp4" },
          ] } },
        ],
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));

  assert.equal(result.candidates[0].media.some((item) => item.kind === "video"), false);
  assert.equal(result.candidates[0].media.some((item) => item.posterUrl === imagePoster), true);
  assert.equal(result.candidates[0].media.some((item) => item.posterUrl === hlsPoster), true);
  assert.equal(result.candidates[0].media.some((item) => item.posterUrl === ambiguousPoster), true);
});

test("MP4 extraction fails closed when generic entity variants exceed the inspection cap", () => {
  const poster = "https://pbs.twimg.com/media/bounded.jpg";
  const variants = Array.from({ length: 32 }, () => ({
    url: "https://video.twimg.com/amplify_video/asset-a/vid/640x360/a.mp4",
  }));
  variants.push({ url: "https://video.twimg.com/amplify_video/asset-b/vid/640x360/b.mp4" });
  const article = syntheticArticle("67896", {
    rest_id: "67896", legacy: { extended_entities: { media: [
      { type: "video", media_url_https: poster, video_info: { variants } },
    ] } },
  });
  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));
  assert.equal(result.candidates[0].media.some(item => item.playbackUrl), false);
});

test("MP4 extraction rejects unsafe generic poster and playback URLs", () => {
  const cases = [
    {
      poster: "http://pbs.twimg.com/media/insecure.jpg",
      playback: "https://video.twimg.com/ext_tw_video/unsafe-a/vid/640x360/a.mp4",
    },
    {
      poster: "https://user@pbs.twimg.com/media/credentials.jpg",
      playback: "https://video.twimg.com:444/ext_tw_video/unsafe-b/vid/640x360/b.mp4",
    },
    {
      poster: "https://pbs.twimg.com:444/media/nondefault-port.jpg",
      playback: "https://video.twimg.com/ext_tw_video/unsafe-c/vid/640x360/c.mp4",
    },
    {
      poster: "https://pbs.twimg.com/media/credentialed-playback.jpg",
      playback: "https://user@video.twimg.com/ext_tw_video/unsafe-c2/vid/640x360/c.mp4",
    },
    {
      poster: "https://pbs.twimg.com/media/no-image-format",
      playback: "https://video.twimg.com.evil.example/ext_tw_video/unsafe-d/vid/640x360/d.mp4",
    },
  ];
  const article = syntheticArticle("67894", {
    rest_id: "67894",
    legacy: {
      extended_entities: {
        media: cases.map(({ poster, playback }) => ({
          type: "video",
          media_url_https: poster,
          video_info: { variants: [{ content_type: "video/mp4", url: playback }] },
        })),
      },
    },
  });

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));

  assert.equal(result.candidates[0].media.some((item) => item.pairing === "same_video_media_entity"), false);
});

test("MP4 extraction cannot borrow generic poster variants from sibling, quoted, or foreign Tweet entities", () => {
  const poster = "https://pbs.twimg.com/media/isolated-generic?format=jpg";
  const foreignPlayback = "https://video.twimg.com/ext_tw_video/foreign-video/vid/1280x720/foreign.mp4";
  const own = {
    __typename: "Tweet",
    rest_id: "67895",
    legacy: {
      full_text: "Owning post",
      extended_entities: {
        media: [{ type: "video", media_url_https: poster }],
      },
    },
    sibling_media: { video_info: { variants: [{ url: foreignPlayback }] } },
    quoted_status_result: {
      result: {
        __typename: "Tweet",
        rest_id: "99999",
        legacy: {
          full_text: "Quoted post",
          extended_entities: {
            media: [{ video_info: { variants: [{ url: "https://video.twimg.com/ext_tw_video/quote-video/vid/1280x720/quoted.mp4" }] } }],
          },
        },
      },
    },
  };
  const article = syntheticArticle("67895", own);

  const result = withDocument([article], () => resolveXStructuredMediaInMainWorld({ playbackFormat: "mp4" }));

  assert.equal(result.candidates[0].media.some((item) => item.pairing === "same_video_media_entity"), false);
  assert.equal(result.candidates[0].media.some((item) => item.posterUrl === poster && item.kind === "image"), true);
  assert.equal(JSON.stringify(result).includes("foreign.mp4"), false);
  assert.equal(JSON.stringify(result).includes("quoted.mp4"), false);
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
