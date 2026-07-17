import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEvidence({ hostname = "example.test", origin = "https://example.test" } = {}) {
  const context = {
    URL,
    location: { hostname, origin },
    queueMicrotask,
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "x-media-evidence-runtime.js"), "utf8"),
    context,
  );
  return context.AkuXMediaEvidence;
}

test("X media evidence admits only bounded allowlisted media URLs", () => {
  const evidence = loadEvidence();
  let now = 1_000;
  const cache = evidence.createCache({ now: () => now, maxMediaPerCandidate: 2 });
  const values = cache.put("https://x.com/aku/status/12345", [
    { url: "https://pbs.twimg.com/media/first.jpg", width: 0, height: 0 },
    { url: "https://evil.example/media/secret.jpg", width: 640, height: 360 },
    { url: "https://pbs.twimg.com/profile_banners/not-post-media.jpg", width: 640, height: 360 },
    { url: "https://pbs.twimg.com/media/second.jpg#fragment", width: 320, height: 180 },
    { url: "https://pbs.twimg.com/media/third.jpg", width: 640, height: 360 },
  ]);

  assert.deepEqual(Array.from(values, (value) => value.url), [
    "https://pbs.twimg.com/media/second.jpg",
    "https://pbs.twimg.com/media/third.jpg",
  ]);
  assert.equal(values.some((value) => "rawResponse" in value), false);
  assert.equal(cache.diagnostics().rejected, 2);
  now += 1;
});

test("X media evidence uses candidate-level LRU and TTL bounds", () => {
  const evidence = loadEvidence();
  let now = 10_000;
  const cache = evidence.createCache({ now: () => now, maxCandidates: 2, ttlMs: 500 });
  const media = (name) => [{ url: `https://pbs.twimg.com/media/${name}.jpg` }];

  cache.put("x:status:11111", media("one"));
  cache.put("x:status:22222", media("two"));
  assert.equal(cache.get("x:status:11111").length, 1); // Touch candidate one.
  cache.put("x:status:33333", media("three"));

  assert.equal(cache.get("x:status:22222").length, 0);
  assert.equal(cache.get("x:status:11111").length, 1);
  assert.equal(cache.diagnostics().evicted, 1);

  now += 501;
  assert.equal(cache.get("x:status:11111").length, 0);
  assert.equal(cache.get("x:status:33333").length, 0);
  assert.equal(cache.diagnostics().expired, 2);
});

test("candidate identity prefers the owning post and ignores a quoted post", () => {
  const evidence = loadEvidence();
  const quote = {};
  const ownAnchor = anchor("https://x.com/owner/status/55555", null);
  const quotedAnchor = anchor("https://x.com/quoted/status/99999", quote);
  const ownTime = { closest: () => ownAnchor, closestQuote: null };
  ownTime.closest = (selector) => selector.includes("quoteTweet") ? null : ownAnchor;
  const quotedTime = {
    closest: (selector) => selector.includes("quoteTweet") ? quote : quotedAnchor,
  };
  const container = {
    querySelectorAll(selector) {
      if (selector === "time") return [quotedTime, ownTime];
      if (selector.includes('a[href*="/status/"]')) return [quotedAnchor, ownAnchor];
      return [];
    },
  };

  assert.equal(evidence.candidateIdFromContainer(container), "x:status:55555");
});

test("structured evidence is sanitized before entering the shared bounded cache", () => {
  const evidence = loadEvidence();
  const published = [];
  const runtime = evidence.createRuntime({
    document: null,
    publish: (candidateId, media) => published.push({ candidateId, media }),
  });
  const accepted = runtime.ingestStructured({
    rawGraphQlResponse: { shouldNeverBeRetained: true },
    candidates: [{
      candidateId: "x:status:77777",
      rawTweet: { full_text: "private state" },
      media: [{
        kind: "video",
        posterUrl: "https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/frame.jpg",
        playbackUrl: "https://video.twimg.com/ext_tw_video/example/pu/vid/avc1/clip.mp4",
        width: 1280,
        height: 720,
        arbitrary: "discard me",
      }],
    }],
  });
  const stored = runtime.lookup("x:status:77777");

  assert.equal(accepted, 1);
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), [
    "alt",
    "height",
    "kind",
    "observedAtMs",
    "playbackMode",
    "playbackUrl",
    "posterUrl",
    "provenance",
    "url",
    "width",
  ]);
  assert.equal(JSON.stringify(stored).includes("private state"), false);
  assert.equal(stored[0].provenance, "main_structured_state");
  assert.equal(published.length, 1);
  assert.equal(published[0].candidateId, "x:status:77777");
  assert.equal(JSON.stringify(published).includes("private state"), false);
  runtime.ingestStructured({ candidates: [{
    candidateId: "x:status:77777",
    media: published[0].media,
  }] });
  assert.equal(published.length, 1);
});

test("response evidence bridge keeps avatars ephemeral and publishes only post media", () => {
  const evidence = loadEvidence({ hostname: "x.com", origin: "https://x.com" });
  const published = [];
  const runtime = evidence.createRuntime({
    document: null,
    publish: (candidateId, media) => published.push({ candidateId, media }),
  });
  let messageHandler;
  const posted = [];
  const windowObject = {
    addEventListener(type, handler) {
      if (type === "message") messageHandler = handler;
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };

  assert.equal(evidence.installResponseEvidenceBridge(runtime, windowObject), true);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    message: {
      type: "AKU_X_RESPONSE_EVIDENCE_READY",
      runtimeRevision: "x-response-evidence-v2",
    },
    targetOrigin: "https://x.com",
  }]);

  messageHandler({
    source: windowObject,
    origin: "https://x.com",
    data: {
      type: "AKU_X_RESPONSE_MEDIA_EVIDENCE",
      runtimeRevision: "x-response-evidence-v2",
      candidates: [{
        candidateId: "x:status:12345",
        avatarUrl: "https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg",
        media: [{
          kind: "image",
          url: "https://pbs.twimg.com/media/from-response.jpg",
          posterUrl: null,
          playbackUrl: null,
          playbackMode: null,
          width: 1200,
          height: 675,
          provenance: "x_response_graphql",
        }],
      }],
      diagnostics: {
        observedResponseCount: 1,
        parsedResponseCount: 1,
        rejectedResponseCount: 0,
        candidateCount: 1,
        mediaCount: 1,
        avatarCount: 1,
        traversedNodeCount: 50,
        bounded: false,
      },
    },
  });

  assert.equal(runtime.lookup("x:status:12345")[0].provenance, "x_response_graphql");
  assert.equal(
    runtime.lookupAvatar("x:status:12345"),
    "https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg",
  );
  assert.equal(published.length, 1);
  assert.equal(JSON.stringify(published).includes("profile_images"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.responseDiagnostics())), {
    runtimeRevision: "x-response-evidence-v2",
    messagesReceived: 1,
    messagesRejected: 0,
    acceptedCandidateCount: 1,
    acceptedAvatarCandidateCount: 1,
    observedResponseCount: 1,
    parsedResponseCount: 1,
    rejectedResponseCount: 0,
    lastCandidateCount: 1,
    lastMediaCount: 1,
    lastAvatarCount: 1,
    lastTraversedNodeCount: 50,
    lastBounded: false,
  });

  messageHandler({
    source: windowObject,
    origin: "https://x.com",
    data: {
      type: "AKU_X_RESPONSE_MEDIA_EVIDENCE",
      runtimeRevision: "x-response-evidence-v2",
      candidates: [],
      diagnostics: {},
      rawResponse: { forbidden: true },
    },
  });
  messageHandler({
    source: windowObject,
    origin: "https://evil.example",
    data: {
      type: "AKU_X_RESPONSE_MEDIA_EVIDENCE",
      runtimeRevision: "x-response-evidence-v2",
      candidates: [],
    },
  });

  assert.equal(published.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.responseDiagnostics())), {
    runtimeRevision: "x-response-evidence-v2",
    messagesReceived: 2,
    messagesRejected: 1,
    acceptedCandidateCount: 1,
    acceptedAvatarCandidateCount: 1,
    observedResponseCount: 1,
    parsedResponseCount: 1,
    rejectedResponseCount: 0,
    lastCandidateCount: 1,
    lastMediaCount: 1,
    lastAvatarCount: 1,
    lastTraversedNodeCount: 50,
    lastBounded: false,
  });
});

test("avatar evidence is strict, bounded, and independent from the post-media cache", () => {
  const evidence = loadEvidence();
  let now = 5_000;
  const avatars = evidence.createAvatarCache({ now: () => now, maxCandidates: 1, ttlMs: 500 });

  assert.equal(
    avatars.put("x:status:11111", "https://pbs.twimg.com/profile_images/11111/one_normal.jpg#fragment"),
    "https://pbs.twimg.com/profile_images/11111/one_normal.jpg",
  );
  assert.equal(avatars.put("x:status:22222", "https://evil.example/profile_images/no.jpg"), null);
  assert.equal(avatars.put("x:status:22222", "https://pbs.twimg.com/media/not-avatar.jpg"), null);
  assert.equal(
    avatars.put("x:status:22222", "https://pbs.twimg.com/profile_images/22222/two_normal.jpg"),
    "https://pbs.twimg.com/profile_images/22222/two_normal.jpg",
  );
  assert.equal(avatars.get("x:status:11111"), null);
  assert.equal(avatars.diagnostics().evicted, 1);
  assert.equal(avatars.diagnostics().rejected, 2);

  now += 501;
  assert.equal(avatars.get("x:status:22222"), null);
  assert.equal(avatars.diagnostics().expired, 1);
});

test("document-start watcher observes bounded URL attributes and keeps media after DOM mutation", () => {
  const evidence = loadEvidence();
  const scheduled = [];
  let observerInstance;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observerInstance = this;
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {}
  }
  const documentObject = { querySelectorAll: () => [] };
  const ownAnchor = anchor("https://x.com/owner/status/88888", null);
  const ownTime = {
    closest: (selector) => selector.includes("quoteTweet") ? null : ownAnchor,
  };
  const image = {
    nodeType: 1,
    currentSrc: "https://pbs.twimg.com/media/early.jpg",
    naturalWidth: 1200,
    naturalHeight: 675,
    closest: (selector) => selector.includes("article") ? container : null,
    getAttribute: () => null,
  };
  const root = {
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [image],
    getAttribute: () => null,
  };
  const container = {
    matches: (selector) => selector.includes("article"),
    closest: () => null,
    querySelectorAll(selector) {
      if (selector === "time") return [ownTime];
      if (selector.includes('a[href*="/status/"]') && !selector.includes("photo")) {
        return [ownAnchor];
      }
      if (selector === '[data-testid="tweetPhoto"]') return [root];
      return [];
    },
  };
  const runtime = evidence.createRuntime({
    document: documentObject,
    MutationObserver: FakeMutationObserver,
    queueMicrotask: (callback) => scheduled.push(callback),
  });

  assert.equal(runtime.start(), true);
  assert.equal(observerInstance.target, documentObject);
  assert.equal(observerInstance.options.attributeFilter.includes("srcset"), true);
  observerInstance.callback([{ target: image, addedNodes: [] }]);
  while (scheduled.length > 0) scheduled.shift()();

  const stored = runtime.lookup("x:status:88888");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].url, "https://pbs.twimg.com/media/early.jpg");
  assert.equal(stored[0].width, 1200);
  assert.equal(stored[0].provenance, "observed_dom");
});

test("X URL normalization rejects credentials, HTTP, and deceptive host suffixes", () => {
  const evidence = loadEvidence();
  assert.equal(evidence.safeXMediaUrl("http://pbs.twimg.com/media/no.jpg"), null);
  assert.equal(evidence.safeXMediaUrl("https://pbs.twimg.com.evil.test/media/no.jpg"), null);
  assert.equal(evidence.safeXMediaUrl("https://user@pbs.twimg.com/media/no.jpg"), null);
  assert.equal(
    evidence.safeXMediaUrl("https://pbs.twimg.com/media/yes.jpg?format=jpg&name=large#x"),
    "https://pbs.twimg.com/media/yes.jpg?format=jpg&name=large",
  );
});

function anchor(href, quote) {
  return {
    href,
    getAttribute: () => href,
    closest: (selector) => selector.includes("quoteTweet") ? quote : null,
  };
}
