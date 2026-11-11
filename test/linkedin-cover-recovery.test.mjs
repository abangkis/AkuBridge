import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { resolveLinkedInStructuredMediaInMainWorld } from "../linkedin-main-world-media-resolver.js";

const root = new URL("../", import.meta.url);
const persisted = JSON.parse(fs.readFileSync(new URL("fixtures/linkedin-7525912124464857088-cover-only.json", import.meta.url)));
const detailRecaptures = JSON.parse(fs.readFileSync(new URL("fixtures/linkedin-7525912124464857088-video-placeholder.json", import.meta.url)));
const target = persisted.block.platformId;
const other = "linkedin:ugcpost:7525912124464857999";
const clone = value => JSON.parse(JSON.stringify(value));
// These media responses and DOM objects are synthetic, not captured LinkedIn DOM.
const syntheticVideo = id => ({ kind: "video", url: persisted.block.media[0].url,
  posterUrl: persisted.block.media[0].url, playbackMode: "inline", width: 1280, height: 720,
  playbackUrl: `https://dms.licdn.com/playlist/vid/v2/synthetic-${id.split(":").at(-1)}/mp4-720p-30fp/0/video` });
const response = (id, media = syntheticVideo(id)) => ({ ok: true, evidence: { candidates: [{ candidateId: id, media: [media] }] } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function reconstructedPost(id = target) {
  const post = { owner: id, isConnected: true, players: [], hasVideo: true,
    getAttribute: name => ["data-urn", "data-id"].includes(name) && post.owner
      ? post.owner.replace("linkedin:", "urn:li:").replace("ugcpost:", "ugcPost:") : null,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "[data-vjs-player][id]") return post.players;
      if (selector === "[data-urn], [data-id], a[href]") return [];
      if (selector === "video, [data-view-name*='video' i], [aria-label*='video' i]") return post.hasVideo ? [{}] : [];
      if (post.placeholder && (selector === "img" || selector === "video" ||
          selector.includes("video, [data-test-document-container]"))) return [];
      if (selector === ".update-components-image, .feed-shared-image") return [];
      if (selector === "[data-test-document-container], iframe[title*='document' i]" || selector === "time") return [];
      return [{ closest: () => null, getBoundingClientRect: () => ({ width: 470, height: 264 }) }];
    },
  };
  post.players.push(playerNode(post, "synthetic-player-" + id.split(":").at(-1)));
  return post;
}
function playerNode(owner, id) {
  return { id, closest: () => owner, matches: () => true,
    querySelector: () => ({ videoWidth: 1280, videoHeight: 720 }),
    getBoundingClientRect: () => ({ width: 1280, height: 720 }) };
}

function runtime(send = async () => ({ ok: true, evidence: { candidates: [] } })) {
  const requests = [], delays = [];
  const context = vm.createContext({ URL, setTimeout, clearTimeout, performance, AbortController,
    location: { href: "https://www.linkedin.com/feed/" },
    chrome: { runtime: { sendMessage(message) { requests.push(message); return send(message); } } },
  });
  for (const file of ["source-adapter-runtime.js", "bounded-capture-policy.js", "capture-quality-policy.js",
    "media-post-processor.js", "adapters/linkedin-adapter.js", "media-acquisition-engine.js", "capture-primitives.js"]) {
    vm.runInContext(fs.readFileSync(new URL(file, root), "utf8"), context);
  }
  const adapter = context.AkuSourceAdapters.get("linkedin");
  const lookup = (post, options = {}) => adapter.mediaAcquisition.extractStructuredCandidates(post,
    { candidateId: target, ...options });
  const cache = id => adapter.structuredMediaEvidence.runtime().lookup(id);
  return { context, adapter, requests, delays, lookup, cache };
}

async function windowedCapture({ send, budget = 1, capturedBlock = persisted.block,
  media = capturedBlock.media, contentKind = capturedBlock.contentKind, reextract,
  placeholder = false, deadlineMs = 5_000, legacyFallback = false } = {}) {
  const r = runtime(send);
  const post = reconstructedPost();
  post.hasVideo = placeholder || contentKind === "video";
  post.placeholder = placeholder;
  let extractions = 0;
  Object.assign(r.context, {
    sourceAdapters: r.context.AkuSourceAdapters, capturePolicy: r.context.AkuBoundedCapturePolicy,
    qualityPolicy: r.context.AkuCaptureQualityPolicy, mediaPostProcessor: r.context.AkuMediaPostProcessor,
    mediaAcquisitionEngine: r.context.AkuMediaAcquisitionEngine,
    assertNoXAccessChallenge: () => {}, discoverSourceCandidates: () => ({ candidates: [post] }),
    isVisibleInViewport: () => true, updateCaptureProgress: () => {},
    findPermalinkDetails: () => ({ url: persisted.block.permalink }), waitForValue: () => null,
    expandSourceContent: () => null, restoreSourceContent: () => {},
    extractBlock: () => {
      extractions++;
      return reextract?.(post, extractions) ?? { ...clone(capturedBlock), media: clone(media), contentKind };
    },
    findMedia: () => clone(media), delay: async ms => { r.delays.push(ms); },
    compactText: value => String(value ?? "").trim(), normalizeCandidateDiagnostics: () => null,
    uniqueElements: values => [...new Set(values)],
    readScrollPosition: () => ({ y: 0 }), viewportHeight: () => 900,
  });
  let source = fs.readFileSync(new URL("content-script.js", root), "utf8");
  if (legacyFallback) {
    // Revert only the quality fallback in memory to prove this fixture detects the original miss.
    const previous = source;
    source = source.replace(/expectedKinds: mediaEvidence\?\.expectedKinds \?\? adapter\.mediaAcquisition\.detectExpectedKinds\(container, \{\s*excludeRoot: quotedRoot, uniqueElements,\s*\}\)/,
      "expectedKinds: mediaEvidence?.expectedKinds ?? []");
    assert.notEqual(source, previous);
  }
  vm.runInContext(source.slice(source.indexOf("  async function captureVisibleSnapshot("),
    source.indexOf("  function assertNoXAccessChallenge(")), r.context);
  vm.runInContext(source.slice(source.indexOf("  function evaluateBlockQuality("),
    source.indexOf("  function extractBlock(")), r.context);
  const snapshot = await r.context.captureVisibleSnapshot("linkedin",
    { maxBlocksPerSnapshot: 3, qualityRetryBudget: budget, qualityRetrySettleMs: 100 },
    null, Date.now() + deadlineMs, "same_window", null);
  return { ...r, snapshot };
}

test("persisted LinkedIn cover-only video with valid text consumes one bounded retry and stays unresolved", async () => {
  assert.equal(persisted.origin.matchingSnapshots, 3);
  assert.equal(persisted.block.text.length, 332);
  const { snapshot, delays, requests } = await windowedCapture();
  const block = snapshot.blocks[0];
  assert.equal(block.text, persisted.block.text);
  assert.equal(block.media[0].url, persisted.block.media[0].url);
  assert.equal(block.media[0].playbackUrl, null);
  assert.equal(block.captureQuality.verdict, "usable_degraded");
  assert.equal(block.mediaRecovery.outcome, "unresolved");
  assert.equal(block.mediaRecovery.attempts, 1);
  assert.deepEqual(delays, [100]);
  assert.equal(requests.length, 2);
});

test("actual detail recapture placeholders trigger the existing retry even with text and contentKind post", async () => {
  for (const fixture of detailRecaptures.recaptures) {
    const legacy = await windowedCapture({ capturedBlock: fixture.block, placeholder: true,
      budget: fixture.coverage.captureQuality.retryBudget, legacyFallback: true });
    assert.equal(legacy.snapshot.blocks[0].captureQuality.verdict, "complete");
    assert.equal(legacy.snapshot.blocks[0].mediaRecovery.attempts, 0);
    assert.deepEqual(legacy.delays, []);
    const r = await windowedCapture({ capturedBlock: fixture.block, placeholder: true,
      budget: fixture.coverage.captureQuality.retryBudget });
    const block = r.snapshot.blocks[0];
    assert.equal(block.text, fixture.block.text);
    assert.equal(block.contentKind, "post");
    assert.equal(block.media.length, 0);
    assert.equal(block.captureQuality.verdict, "usable_degraded");
    assert.equal(block.captureQuality.attempt, 1);
    assert.equal(block.mediaRecovery.outcome, "unresolved");
    assert.equal(block.mediaRecovery.attempts, 1);
    assert.deepEqual(r.delays, [100]);
    assert.equal(r.requests.length, 2);
  }
});

test("detail placeholder retry can recover the correctly owned synthetic player", async () => {
  let calls = 0;
  const r = await windowedCapture({ capturedBlock: detailRecaptures.recaptures[1].block, placeholder: true,
    send: async request => ++calls === 1 ? { ok: true, evidence: { candidates: [] } }
      : scopedSyntheticResponse(request) });
  const block = r.snapshot.blocks[0];
  assert.equal(block.captureQuality.verdict, "complete");
  assert.equal(block.mediaRecovery.outcome, "recovered");
  assert.equal(block.mediaRecovery.attempts, 1);
  assert.equal(block.platformId, target);
  assert.equal(block.media[0].playbackUrl, syntheticVideo(target).playbackUrl);
  assert.equal(r.cache(other).length, 0);
  assert.deepEqual(r.delays, [100]);
});

test("detail placeholder does not expand quota or start a settle beyond its deadline", async () => {
  for (const limits of [{ budget: 0 }, { deadlineMs: 50 }]) {
    const r = await windowedCapture({ capturedBlock: detailRecaptures.recaptures[1].block,
      placeholder: true, ...limits });
    const block = r.snapshot.blocks[0];
    assert.equal(block.captureQuality.verdict, "usable_degraded");
    assert.equal(block.mediaRecovery.outcome, "unresolved");
    assert.equal(block.mediaRecovery.attempts, 0);
    assert.equal(block.text, detailRecaptures.recaptures[1].block.text);
    assert.deepEqual(r.delays, []);
    assert.equal(r.requests.length, 1);
  }
});

function scopedSyntheticResponse(request) {
  const post = reconstructedPost(request.candidateIds[0]);
  post.players[0].id = request.playerIds[0];
  const evidence = resolveLinkedInStructuredMediaInMainWorld({ ...request,
    document: { querySelectorAll: selector => selector === "[data-vjs-player]" ? post.players : [] },
    videojs: { getPlayer: () => ({ currentSources: () => [{ src: syntheticVideo(target).playbackUrl,
      poster: persisted.block.media[0].url }] }) },
  });
  return { ok: true, evidence };
}

test("Windowed actual adapter/quality/acquisition recovers only the scoped player within existing retry", async () => {
  let calls = 0;
  const result = await windowedCapture({ send: async request => {
    if (++calls === 1) return { ok: true, evidence: { candidates: [] } };
    return scopedSyntheticResponse(request);
  } });
  const block = result.snapshot.blocks[0];
  assert.equal(block.captureQuality.verdict, "complete");
  assert.equal(block.mediaRecovery.outcome, "recovered");
  assert.equal(block.mediaRecovery.attempts, 1);
  assert.equal(block.media[0].kind, "video");
  assert.equal(block.media[0].playbackUrl, syntheticVideo(target).playbackUrl);
  assert.deepEqual(result.delays, [100]);
});

test("no retry quota preserves unresolved cover; ordinary photos and playable LinkedIn video remain complete", async () => {
  const unresolved = await windowedCapture({ budget: 0 });
  assert.equal(unresolved.snapshot.blocks[0].mediaRecovery.outcome, "unresolved");
  assert.equal(unresolved.snapshot.blocks[0].media.length, 1);
  assert.equal(unresolved.snapshot.blocks[0].captureQuality.verdict, "usable_degraded");
  for (const options of [{ contentKind: "post" }, { media: [syntheticVideo(target)] }]) {
    const r = await windowedCapture(options);
    assert.equal(r.snapshot.blocks[0].captureQuality.verdict, "complete");
    assert.equal(r.snapshot.blocks[0].mediaRecovery.outcome, "primary_complete");
    assert.deepEqual(r.delays, []);
  }
});

test("two simultaneous post/player scans remain isolated and reject a foreign response candidate", async () => {
  const waits = [deferred(), deferred()];
  const r = runtime(() => waits[r.requests.length - 1].promise);
  const a = reconstructedPost(), b = reconstructedPost(other);
  const ap = r.lookup(a), bp = r.lookup(b, { candidateId: other });
  assert.equal(r.requests.length, 2);
  waits[1].resolve(response(other));
  waits[0].resolve({ ok: true, evidence: { candidates: [response(target).evidence.candidates[0],
    { candidateId: "linkedin:ugcpost:9999999999", media: [syntheticVideo(other)] }] } });
  assert.equal((await ap)[0].playbackUrl, syntheticVideo(target).playbackUrl);
  assert.equal((await bp)[0].playbackUrl, syntheticVideo(other).playbackUrl);
  assert.equal(r.cache("linkedin:ugcpost:9999999999").length, 0);
});

test("only the same scoped caller lifetime shares a request", async () => {
  const waits = [deferred(), deferred()], r = runtime(() => waits[r.requests.length - 1].promise);
  const post = reconstructedPost(), controller = new AbortController();
  const first = r.lookup(post), duplicate = r.lookup(post);
  assert.equal(r.requests.length, 1);
  const cancelled = r.lookup(post, { signal: controller.signal });
  assert.equal(r.requests.length, 2);
  controller.abort();
  assert.equal((await cancelled).length, 0);
  waits[1].resolve(response(other));
  waits[0].resolve(response(target));
  assert.equal((await first)[0].playbackUrl, syntheticVideo(target).playbackUrl);
  assert.equal((await duplicate)[0].playbackUrl, syntheticVideo(target).playbackUrl);
  assert.equal(r.cache(other).length, 0);
});

test("missing/wrong identity and nested foreign player cannot issue a scoped request", async () => {
  for (const mutate of [p => { p.owner = other; }, p => { p.owner = null; }, p => { p.players = []; },
    p => { p.players = [playerNode(reconstructedPost(other), "nested-quote-player")]; }]) {
    const r = runtime(() => response(target));
    const post = reconstructedPost(); mutate(post);
    assert.equal((await r.lookup(post)).length, 0);
    assert.equal(r.requests.length, 0);
    assert.equal(r.cache(target).length, 0);
  }
  const r = runtime(() => response(target));
  assert.equal((await r.lookup(reconstructedPost(), { candidateId: null })).length, 0);
  assert.equal(r.requests.length, 0);
});

test("wrong post responses never prime either candidate cache", async () => {
  const r = runtime(() => response(other));
  assert.equal((await r.lookup(reconstructedPost())).length, 0);
  assert.equal(r.cache(target).length, 0);
  assert.equal(r.cache(other).length, 0);
});

test("late owner/player/page changes reject results and subsequent cache lookups", async () => {
  for (const mutate of [p => { p.owner = other; }, p => { p.owner = null; },
    p => { p.players = [playerNode(p, p.players[0].id)]; },
    p => { p.players[0].id = "recycled-player"; }, p => { p.isConnected = false; },
    (_p, r) => { r.context.location.href = "https://www.linkedin.com/feed/other"; }]) {
    const wait = deferred(), r = runtime(() => wait.promise), post = reconstructedPost();
    const result = r.lookup(post); mutate(post, r); wait.resolve(response(target));
    assert.equal((await result).length, 0);
    assert.equal(r.cache(target).length, 0);
    assert.equal(r.cache(other).length, 0);
  }
});

test("cancelled/deadline requests cannot ingest late responses or send after expiry", async () => {
  for (const cancellation of ["abort", "deadline"]) {
    const wait = deferred(), r = runtime(() => wait.promise), post = reconstructedPost();
    const abort = new AbortController();
    const result = r.lookup(post, { signal: abort.signal,
      deadlineAtMs: Date.now() + (cancellation === "deadline" ? 10 : 1000) });
    if (cancellation === "abort") abort.abort();
    assert.equal((await result).length, 0);
    wait.resolve(response(target)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.cache(target).length, 0);
    assert.equal(r.adapter.structuredMediaEvidence.runtime().diagnostics().accepted, 0);
  }
  const r = runtime(() => response(target));
  assert.equal((await r.lookup(reconstructedPost(), { deadlineAtMs: Date.now() - 1 })).length, 0);
  assert.equal(r.requests.length, 0);
});

test("acquisition does not adopt recycled post B hydration after scoped await for A", async () => {
  const wait = deferred(), r = runtime(() => wait.promise), post = reconstructedPost();
  let alternateReads = 0;
  const result = r.context.AkuMediaAcquisitionEngine.acquire({ source: "linkedin", container: post,
    candidateId: target, contentKind: "video", initialMedia: clone(persisted.block.media),
    mediaRootDetected: true, attemptsAvailable: 1, deadlineAtMs: Date.now() + 1000,
    mediaEvidence: { initialMedia: clone(persisted.block.media), expectedKinds: ["video"],
      candidateId: target, signal: "owned", matchesOwner: () => post.owner === target,
      readAvailableCandidates: () => { alternateReads++; return [syntheticVideo(other)]; } },
    extractPrimary: () => [syntheticVideo(other)], delay: async () => {},
  });
  post.owner = other; wait.resolve(response(target));
  const resolved = await result;
  assert.equal(resolved.audit.outcome, "unresolved");
  assert.equal(resolved.media[0].kind, "image");
  assert.equal(resolved.media[0].playbackUrl, null);
  assert.equal(alternateReads, 0);
  assert.equal(r.cache(target).length, 0);
});

test("Windowed re-extraction never merges A recovery into B or a now-unidentified block", async () => {
  for (const missingIdentity of [false, true]) {
    let currentPost;
    const ownImage = { kind: "image", width: 640, height: 360,
      url: "https://media.licdn.com/dms/image/v2/synthetic-post-b/photo/0/image" };
    const nextBlock = { platformId: missingIdentity ? null : other,
      permalink: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7525912124464857999/",
      author: "Synthetic post B", text: "A distinct reconstructed post B with its own retained photo evidence.",
      contentKind: "post", media: [ownImage] };
    const r = await windowedCapture({
      reextract(post, extraction) {
        currentPost = post;
        return extraction > 1 ? clone(nextBlock) : undefined;
      },
      send: async () => {
        await Promise.resolve();
        currentPost.owner = missingIdentity ? null : other;
        currentPost.hasVideo = false;
        return response(target);
      },
    });
    const block = r.snapshot.blocks[0];
    assert.equal(block.platformId, nextBlock.platformId);
    assert.equal(block.media.length, 1);
    assert.equal(block.media[0].url, ownImage.url);
    assert.equal(block.media[0].playbackUrl ?? null, null);
    assert.equal(block.captureQuality.candidateKey, nextBlock.platformId ?? nextBlock.permalink);
    assert.notEqual(block.mediaRecovery.outcome, "unresolved");
    assert.equal(block.mediaRecovery.limitation, "");
    assert.equal(r.cache(target).length, 0);
    assert.equal(JSON.stringify(block).includes(persisted.block.media[0].url), false);
    assert.equal(JSON.stringify(block).includes(syntheticVideo(target).playbackUrl), false);
  }
});

test("LinkedIn acquisition preserves cover without starting a wait beyond deadline or after abort", async () => {
  for (const cancelled of [false, true]) {
    const r = runtime(), post = reconstructedPost(), abort = new AbortController();
    if (cancelled) abort.abort();
    const result = await r.context.AkuMediaAcquisitionEngine.acquire({ source: "linkedin", container: post,
      candidateId: target, contentKind: "video", initialMedia: clone(persisted.block.media),
      mediaRootDetected: true, attemptsAvailable: 1, deadlineAtMs: Date.now() + 50,
      signal: abort.signal, extractPrimary: () => { throw new Error("no hydration expected"); },
      delay: async () => { throw new Error("no wait may exceed remaining time"); } });
    assert.equal(result.audit.outcome, "unresolved");
    assert.equal(result.audit.attempts, 0);
    assert.equal(result.media[0].url, persisted.block.media[0].url);
    assert.equal(r.requests.length, cancelled ? 0 : 1);
  }
});
