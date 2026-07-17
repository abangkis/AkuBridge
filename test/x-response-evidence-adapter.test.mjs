import test from "node:test";
import assert from "node:assert/strict";
import "../x-response-evidence-adapter.js";

const installXResponseEvidenceAdapterInMainWorld =
  globalThis.__akuInstallXResponseEvidenceAdapterInMainWorld;

const HOME_URL = "https://x.com/i/api/graphql/query/HomeTimeline";

test("fetch observation emits only sanitized owning and quoted Tweet evidence without consuming the native response", async () => {
  const payload = timelinePayload({
    outerId: "12345",
    outerMedia: photo("outer", "Private outer text"),
    quotedId: "67890",
    quotedMedia: photo("quoted", "Private quoted text"),
  });
  const nativeResponse = jsonResponse(payload, HOME_URL);
  const nativePromise = Promise.resolve(nativeResponse);
  const harness = installHarness(() => nativePromise);
  try {
    const returned = globalThis.fetch(HOME_URL);
    assert.equal(returned, nativePromise, "the native fetch promise must be returned unchanged");
    assert.equal(await returned, nativeResponse);
    assert.deepEqual(await nativeResponse.json(), payload, "the page must retain its untouched response body");
    await settle();

    assert.equal(harness.messages.length, 1);
    const detail = harness.messages[0];
    assert.equal(detail.runtimeRevision, "x-response-evidence-v2");
    assert.equal(detail.type, "AKU_X_RESPONSE_MEDIA_EVIDENCE");
    assert.deepEqual(detail.candidates.map((value) => value.candidateId), ["x:status:12345", "x:status:67890"]);
    assert.equal(detail.candidates[0].media[0].url, "https://pbs.twimg.com/media/outer.jpg?format=jpg&name=large");
    assert.equal(detail.candidates[1].media[0].url, "https://pbs.twimg.com/media/quoted.jpg?format=jpg&name=large");
    assert.equal(JSON.stringify(detail).includes("Private"), false);
    assert.deepEqual(Object.keys(detail.diagnostics).sort(), [
      "avatarCount", "bounded", "candidateCount", "mediaCount", "observedResponseCount",
      "parsedResponseCount", "rejectedResponseCount", "traversedNodeCount",
    ]);
  } finally {
    harness.restore();
  }
});

test("response evidence emits each Tweet owner's avatar separately from post media", async () => {
  const payload = timelinePayload({
    outerId: "12456",
    outerMedia: [],
    outerAvatar: "https://pbs.twimg.com/profile_images/12456/outer_normal.jpg",
    quotedId: "67901",
    quotedMedia: [],
    quotedAvatar: "https://pbs.twimg.com/profile_images/67901/quoted_normal.jpg",
  });
  const harness = installHarness(() => Promise.resolve(jsonResponse(payload, HOME_URL)));
  try {
    await globalThis.fetch(HOME_URL);
    await settle();

    const detail = harness.messages[0];
    assert.deepEqual(detail.candidates, [
      {
        candidateId: "x:status:12456",
        media: [],
        avatarUrl: "https://pbs.twimg.com/profile_images/12456/outer_normal.jpg",
      },
      {
        candidateId: "x:status:67901",
        media: [],
        avatarUrl: "https://pbs.twimg.com/profile_images/67901/quoted_normal.jpg",
      },
    ]);
    assert.equal(detail.diagnostics.avatarCount, 2);
    assert.equal(detail.diagnostics.mediaCount, 0);
  } finally {
    harness.restore();
  }
});

test("video evidence selects the highest bitrate MP4 and emits at most four media items", async () => {
  const media = [video("clip"), ...Array.from({ length: 8 }, (_, index) => photo(`image-${index}`))];
  const harness = installHarness(() => Promise.resolve(jsonResponse(timelinePayload({ outerId: "23456", outerMedia: media }), HOME_URL)));
  try {
    const pageResponse = await globalThis.fetch(HOME_URL);
    await pageResponse.text();
    await settle();
    const values = harness.messages[0].candidates[0].media;
    assert.equal(values.length, 4);
    assert.deepEqual(values[0], {
      kind: "video",
      url: "https://pbs.twimg.com/ext_tw_video_thumb/clip/pu/img/poster.jpg",
      posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/clip/pu/img/poster.jpg",
      playbackUrl: "https://video.twimg.com/ext_tw_video/clip/pu/vid/1280x720/high.mp4",
      width: 1280,
      height: 720,
      provenance: "x_response_graphql",
    });
  } finally {
    harness.restore();
  }
});

test("response evidence recovers an allowlisted X link-card image owned by the Tweet", async () => {
  const payload = timelinePayload({ outerId: "24567", outerMedia: [] });
  const tweetResult = payload.data.home.instructions[0].entries[0].content.itemContent.tweet_results.result;
  tweetResult.card = {
    legacy: {
      binding_values: {
        thumbnail_image_large: {
          image_value: {
            url: "https://pbs.twimg.com/card_img/12345/example.jpg?format=jpg&name=large",
            width: 1200,
            height: 628,
          },
        },
      },
    },
  };
  const response = jsonResponse(payload, HOME_URL);
  const harness = installHarness(() => Promise.resolve(response));
  try {
    const pageResponse = await globalThis.fetch(HOME_URL);
    await pageResponse.text();
    await settle();
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.messages[0].candidates[0].media[0], {
      kind: "image",
      url: "https://pbs.twimg.com/card_img/12345/example.jpg?format=jpg&name=large",
      posterUrl: "https://pbs.twimg.com/card_img/12345/example.jpg?format=jpg&name=large",
      playbackUrl: null,
      width: 1200,
      height: 628,
      provenance: "x_response_graphql",
    });
  } finally {
    harness.restore();
  }
});

test("only exact X GraphQL timeline operations are observed", async () => {
  const urls = [
    "https://x.com.evil.example/i/api/graphql/query/HomeTimeline",
    "https://x.com@evil.example/i/api/graphql/query/HomeTimeline",
    "https://api.x.com/i/api/graphql/query/HomeTimeline",
    "http://x.com/i/api/graphql/query/HomeTimeline",
    "https://x.com/i/api/graphql/query/SearchTimeline",
    "https://x.com/i/api/1.1/statuses/home_timeline.json",
    "https://x.com/i/api/graphql/query/HomeTimeline/extra",
  ];
  const harness = installHarness((url) => Promise.resolve(jsonResponse(timelinePayload({ outerId: "34567", outerMedia: photo("blocked") }), String(url))));
  try {
    for (const url of urls) await globalThis.fetch(url);
    await settle();
    assert.equal(harness.messages.length, 0);

    for (const operation of ["HomeTimeline", "HomeLatestTimeline", "TweetDetail"]) {
      const url = `https://x.com/i/api/graphql/query/${operation}`;
      await globalThis.fetch(url);
    }
    await settle();
    assert.equal(harness.messages.length, 3);
  } finally {
    harness.restore();
  }
});

test("deceptive media hosts, credentials, unrelated fields, and text never cross the boundary", async () => {
  const payload = timelinePayload({ outerId: "45678", outerMedia: [
    { type: "photo", media_url_https: "https://pbs.twimg.com.evil.example/media/bad.jpg", original_info: { width: 10, height: 10 } },
    { type: "photo", media_url_https: "https://pbs.twimg.com@evil.example/media/bad.jpg", original_info: { width: 10, height: 10 } },
    { type: "photo", media_url_https: "https://pbs.twimg.com/profile_images/avatar.jpg", original_info: { width: 10, height: 10 } },
    photo("safe", "DO NOT LEAK THIS"),
  ] });
  payload.secret = "top-level secret";
  payload.collector_url = "https://collector.example/private";
  const harness = installHarness(() => Promise.resolve(jsonResponse(payload, HOME_URL)));
  try {
    await globalThis.fetch(HOME_URL);
    await settle();
    const serialized = JSON.stringify(harness.messages);
    assert.equal(serialized.includes("evil.example"), false);
    assert.equal(serialized.includes("profile_images"), false);
    assert.equal(serialized.includes("DO NOT LEAK"), false);
    assert.equal(serialized.includes("top-level secret"), false);
    assert.equal(serialized.includes("collector.example"), false);
    assert.equal(harness.messages[0].candidates[0].media.length, 1);
  } finally {
    harness.restore();
  }
});

test("oversized bodies and traversal bombs are bounded and failure-soft", async () => {
  const oversized = JSON.stringify(timelinePayload({ outerId: "56789", outerMedia: photo("oversized") })) + " ".repeat(40_000);
  const bomb = {};
  let current = bomb;
  for (let index = 0; index < 500; index += 1) {
    current.next = { noise: index };
    current = current.next;
  }
  current.result = timelinePayload({ outerId: "98765", outerMedia: photo("too-deep") });
  const oversizedResponse = new Response(oversized, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  defineResponseURL(oversizedResponse, HOME_URL);
  const harness = installHarness(
    () => Promise.resolve(oversizedResponse),
    { maxBodyBytes: 16_384, maxTraversalNodes: 100, maxDepth: 4 },
  );
  try {
    await globalThis.fetch(HOME_URL);
    await settle(60);
    const xhr = new XMLHttpRequest();
    xhr.open("GET", HOME_URL);
    xhr.respond(HOME_URL, bomb);
    xhr.send();
    await settle(100);
    assert.equal(harness.messages.length, 2);
    assert.equal(harness.messages.every((value) => value.candidates.length === 0), true);
    assert.equal(harness.messages.at(-1).diagnostics.rejectedResponseCount, 1);
    assert.equal(harness.messages.at(-1).diagnostics.parsedResponseCount, 1);
    assert.equal(harness.messages.at(-1).diagnostics.bounded, true);
  } finally {
    harness.restore();
  }
});

test("getter and cycle traps are ignored without executing getters", async () => {
  let getterCalls = 0;
  const tweet = { __typename: "Tweet", rest_id: "65432", legacy: { full_text: "safe" } };
  tweet.self = tweet;
  Object.defineProperty(tweet, "extended_entities", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error("must not execute"); },
  });
  const harness = installHarness(() => Promise.reject(new Error("unused")), {}, FakeXMLHttpRequest);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", HOME_URL);
    xhr.respond(HOME_URL, { data: { result: tweet } });
    xhr.send();
    assert.equal(getterCalls, 0);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0].candidates.length, 0);
  } finally {
    harness.restore();
  }
});

test("installation is idempotent and READY replays only bounded sanitized cache", async () => {
  const harness = installHarness(() => Promise.resolve(jsonResponse(timelinePayload({ outerId: "76543", outerMedia: photo("cached") }), HOME_URL)));
  try {
    const second = installXResponseEvidenceAdapterInMainWorld();
    assert.equal(second, harness.controller);
    await globalThis.fetch(HOME_URL);
    await settle();
    assert.equal(harness.messages.length, 1);
    harness.ready();
    assert.equal(harness.messages.length, 2);
    assert.equal(harness.messages[1].diagnostics.candidateCount, 1);
    assert.equal(JSON.stringify(harness.messages[1]).includes("full_text"), false);
  } finally {
    harness.restore();
  }
});

test("READY replay evicts older evidence at the configured cache bound", async () => {
  let sequence = 0;
  const harness = installHarness(() => {
    sequence += 1;
    const id = String(80000 + sequence);
    return Promise.resolve(jsonResponse(timelinePayload({ outerId: id, outerMedia: photo(`cache-${id}`) }), HOME_URL));
  }, { maxCachedCandidates: 2 });
  try {
    await globalThis.fetch(HOME_URL);
    await globalThis.fetch(HOME_URL);
    await globalThis.fetch(HOME_URL);
    await settle();
    harness.ready();
    const replay = harness.messages.at(-1);
    assert.equal(replay.diagnostics.candidateCount, 2);
    assert.deepEqual(replay.candidates.map((value) => value.candidateId), ["x:status:80002", "x:status:80003"]);
  } finally {
    harness.restore();
  }
});

test("READY replay chunks the bounded cache into bridge-valid envelopes", () => {
  const harness = installHarness(() => Promise.reject(new Error("unused")), {
    maxCachedCandidates: 30,
  }, FakeXMLHttpRequest);
  try {
    for (let index = 0; index < 30; index += 1) {
      const id = String(90000 + index);
      const xhr = new XMLHttpRequest();
      xhr.open("GET", HOME_URL);
      xhr.respond(HOME_URL, timelinePayload({ outerId: id, outerMedia: photo(`chunk-${id}`) }));
      xhr.send();
    }
    const beforeReplay = harness.messages.length;
    harness.ready();
    const replay = harness.messages.slice(beforeReplay);
    assert.deepEqual(replay.map((value) => value.candidates.length), [24, 6]);
    assert.equal(replay.every((value) => value.candidates.length <= 24), true);
  } finally {
    harness.restore();
  }
});

test("non-X documents are left completely unpatched", () => {
  const originalFetch = () => "native";
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", hostname: "example.com", href: "https://example.com/" },
  });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
  try {
    const controller = installXResponseEvidenceAdapterInMainWorld();
    assert.equal(controller.installed, false);
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(globalThis.__akuXResponseEvidenceAdapterV2, undefined);
  } finally {
    if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation);
    else delete globalThis.location;
    if (priorFetch) Object.defineProperty(globalThis, "fetch", priorFetch);
    else delete globalThis.fetch;
  }
});

test("XHR observation preserves native return values and ignores unrelated requests", () => {
  const harness = installHarness(() => Promise.reject(new Error("unused")), {}, FakeXMLHttpRequest);
  try {
    const xhr = new XMLHttpRequest();
    assert.equal(xhr.open("GET", HOME_URL), "native-open");
    xhr.respond(HOME_URL, timelinePayload({ outerId: "87654", outerMedia: photo("xhr") }));
    assert.equal(xhr.send("body"), "native-send");
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0].candidates[0].candidateId, "x:status:87654");

    const unrelated = new XMLHttpRequest();
    unrelated.open("GET", "https://x.com/i/api/1.1/account/settings.json");
    unrelated.respond("https://x.com/i/api/1.1/account/settings.json", timelinePayload({ outerId: "99998", outerMedia: photo("nope") }));
    unrelated.send();
    assert.equal(harness.messages.length, 1);
  } finally {
    harness.restore();
  }
});

function installHarness(fetchImpl, options = {}, XHR = FakeXMLHttpRequest) {
  const prior = new Map();
  for (const key of ["location", "window", "fetch", "XMLHttpRequest", "postMessage", "addEventListener", "removeEventListener"]) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const events = new EventTarget();
  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      get() { return { protocol: "https:", hostname: "x.com", href: "https://x.com/home" }; },
    },
    window: { configurable: true, value: globalThis },
    fetch: { configurable: true, writable: true, value: fetchImpl },
    XMLHttpRequest: { configurable: true, writable: true, value: XHR },
    addEventListener: { configurable: true, writable: true, value: events.addEventListener.bind(events) },
    removeEventListener: { configurable: true, writable: true, value: events.removeEventListener.bind(events) },
    postMessage: {
      configurable: true,
      writable: true,
      value(message, targetOrigin) {
        if (targetOrigin !== "https://x.com") return;
        const event = new Event("message");
        Object.defineProperties(event, {
          source: { value: globalThis },
          origin: { value: "https://x.com" },
          data: { value: message },
        });
        events.dispatchEvent(event);
      },
    },
  });
  const messages = [];
  events.addEventListener("message", (event) => {
    if (event.data?.type === "AKU_X_RESPONSE_MEDIA_EVIDENCE") messages.push(event.data);
  });
  const controller = installXResponseEvidenceAdapterInMainWorld(options);
  return {
    controller,
    messages,
    ready() {
      globalThis.postMessage({
        type: "AKU_X_RESPONSE_EVIDENCE_READY",
        runtimeRevision: "x-response-evidence-v2",
      }, "https://x.com");
    },
    restore() {
      controller.uninstall?.();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      delete globalThis.__akuXResponseEvidenceAdapterV2;
    },
  };
}

class FakeXMLHttpRequest extends EventTarget {
  open() { return "native-open"; }
  send() { this.dispatchEvent(new Event("loadend")); return "native-send"; }
  respond(url, payload) {
    this.status = 200;
    this.responseURL = url;
    this.responseType = "json";
    this.response = payload;
  }
}

function timelinePayload({ outerId, outerMedia, outerAvatar, quotedId, quotedMedia, quotedAvatar }) {
  const outer = tweet(outerId, outerMedia, outerAvatar);
  if (quotedId) outer.quoted_status_result = { result: tweet(quotedId, quotedMedia, quotedAvatar) };
  return { data: { home: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: outer } } } }] }] } } };
}

function tweet(id, media, avatarUrl) {
  const value = {
    __typename: "Tweet",
    rest_id: id,
    legacy: {
      full_text: `private text for ${id}`,
      extended_entities: { media: Array.isArray(media) ? media : [media] },
    },
  };
  if (avatarUrl) {
    value.core = { user_results: { result: { legacy: { profile_image_url_https: avatarUrl } } } };
  }
  return value;
}

function photo(name, text = "") {
  return {
    type: "photo",
    media_url_https: `https://pbs.twimg.com/media/${name}.jpg?format=jpg&name=large`,
    original_info: { width: 1600, height: 900 },
    ext_alt_text: text,
  };
}

function video(name) {
  return {
    type: "video",
    media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/${name}/pu/img/poster.jpg`,
    original_info: { width: 1280, height: 720 },
    video_info: { variants: [
      { content_type: "application/x-mpegURL", url: `https://video.twimg.com/ext_tw_video/${name}/pu/pl/master.m3u8` },
      { content_type: "video/mp4", bitrate: 256000, url: `https://video.twimg.com/ext_tw_video/${name}/pu/vid/320x180/low.mp4` },
      { content_type: "video/mp4", bitrate: 2176000, url: `https://video.twimg.com/ext_tw_video/${name}/pu/vid/1280x720/high.mp4` },
    ] },
  };
}

function jsonResponse(payload, url) {
  const response = new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  defineResponseURL(response, url);
  return response;
}

function defineResponseURL(response, url) {
  Object.defineProperty(response, "url", { configurable: true, value: url });
}

async function settle(milliseconds = 20) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
