import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "test", "fixtures", "media-recovery-cases.json"),
  "utf8",
));

test("media acquisition accepts already complete primary media without retry", async () => {
  const context = runtimeContext(() => []);
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [media("https://pbs.twimg.com/media/primary.jpg")],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [],
    delay: async () => {},
  });
  assert.equal(result.audit.outcome, "primary_complete");
  assert.equal(result.audit.attempts, 0);
  assert.deepEqual([...result.audit.trace], ["primary_complete"]);
});

test("X keeps poster-only and HLS unresolved until deferred owned MP4 arrives", async () => {
  const context = runtimeContext(() => [], { expectedKinds: ["video"], useRealPolicy: true });
  const poster = media("https://pbs.twimg.com/ext_tw_video_thumb/23456/pu/img/poster.jpg", "video");
  const base = "https://video.twimg.com/ext_tw_video/23456/pu/vid/avc1/";
  const acquire = initialMedia => context.AkuMediaAcquisitionEngine.acquire({ source: "x", container: {}, initialMedia });
  for (const candidate of [poster, { ...poster, playbackUrl: base + "clip.m3u8" }]) {
    const result = await acquire([candidate]);
    assert.equal(result.audit.outcome, "unresolved");
    assert.equal(result.audit.limitation, "video_stream_not_resolved");
    assert.equal(result.media[0].posterUrl, poster.url);
    assert.equal(result.media[0].playbackUrl, null);
    assert.equal(context.AkuMediaAcquisitionEngine.summarize([result.audit]).outcomes.unresolved, 1);

    const block = { platformId: "x:status:23456", media: result.media, mediaRecovery: result.audit };
    const snapshots = [{ blocks: [block] }];
    const processor = context.AkuMediaPostProcessor;
    processor.processSnapshots("x", snapshots, () => [{ ...poster, kind: "image" }]);
    assert.equal(block.mediaRecovery.outcome, "unresolved");
    processor.processSnapshots("x", snapshots, () => [{ ...poster, playbackUrl: base + "clip.mp4" }]);
    assert.equal(block.mediaRecovery.outcome, "recovered");
    assert.equal(block.mediaRecovery.limitation, "");
    assert.equal(block.media[0].playbackUrl, base + "clip.mp4");
  }
});

test("Windowed X uses shared media evidence and only waits for a post that needs media", async () => {
  const postUrl = "https://pbs.twimg.com/media/owned.jpg";
  for (const fixture of [
    { name: "ready text and DOM media", text: "Text ready", primary: true, verdict: "complete", outcome: "primary_complete", saved: true },
    { name: "ready text and missing owned media", text: "Text ready", verdict: "usable_degraded", outcome: "unavailable" },
    { name: "ready text and already-readable alternate media", text: "Text ready", alternate: true, verdict: "complete", outcome: "recovered", saved: true },
    { name: "media-only with delayed image", hydrate: true, verdict: "complete", outcome: "recovered", saved: true, waits: 1 },
    { name: "media-only with no URL after retry", verdict: "invalid", waits: 1 },
    { name: "media-only without retry quota", verdict: "invalid", retryBudget: 0 },
    { name: "media-only without enough time to settle", verdict: "invalid", timeLeft: 500 },
    { name: "virtualized post changes owner during retry", hydrate: true, replaceOwner: true, verdict: "invalid", waits: 1 },
    { name: "ambiguous media on ready text", text: "Text ready", ambiguous: true, verdict: "complete", outcome: "not_applicable" },
    { name: "ambiguous media without text", ambiguous: true, verdict: "invalid" },
    { name: "foreign photo link", text: "Text ready", foreign: true, verdict: "complete", outcome: "not_applicable" },
    { name: "quote is excluded from the primary observation", text: "Text ready", quote: true, alternate: true, verdict: "complete", outcome: "not_applicable" },
  ]) {
    const { snapshot, delays } = await captureXMediaFixture(fixture, postUrl);
    assert.deepEqual(delays, fixture.waits ? [700] : [], fixture.name);
    assert.equal(snapshot.qualityReports[0].verdict, fixture.verdict, fixture.name);
    const block = snapshot.blocks[0];
    if (fixture.verdict === "invalid") {
      assert.equal(block, undefined, fixture.name);
      continue;
    }
    assert.equal(block.mediaRecovery.outcome, fixture.outcome, fixture.name);
    assert.equal(block.mediaRecovery.attempts, fixture.waits ?? 0, fixture.name);
    assert.equal(block.media[0]?.url, fixture.saved ? postUrl : undefined, fixture.name);
    if (fixture.ambiguous || fixture.foreign) {
      assert.equal(block.mediaRecovery.evidenceSignal, "ambiguous", fixture.name);
    }
  }
});

async function captureXMediaFixture(fixture, url) {
  const delays = [];
  const owner = () => fixture.replaceOwner && delays.length ? "54321" : "23456";
  const image = { src: url, getBoundingClientRect: () => ({ width: 640, height: 360 }) };
  const foreign = { href: "https://x.com/other/status/99999/photo/1" };
  const root = {
    matches: selector => fixture.foreign ? selector.includes('/photo/') :
      !fixture.ambiguous && selector.includes("tweetPhoto"),
    closest: selector => fixture.foreign && selector.includes('/photo/') ? foreign : null,
    querySelectorAll: selector => selector === "img" && fixture.alternate ? [image] : [],
  };
  const article = {
    tagName: "ARTICLE",
    parentElement: { matches: () => true, getAttribute: () => `/owner/status/${owner()}` },
    querySelector: selector => fixture.quote && selector.includes("quoteTweet") ? { contains: node => node === root } : null,
    querySelectorAll(selector) {
      if (fixture.foreign) return selector.includes('/photo/') ? [root] : [];
      if (fixture.ambiguous) return selector.includes('a[aria-label][href] img,') ? [root] : [];
      return selector.includes("tweetPhoto") ? [root] : [];
    },
  };
  const findMedia = () => fixture.primary || fixture.hydrate && delays.length && !fixture.replaceOwner ? [media(url)] : [];
  const context = vm.createContext({
    URL, assertNoXAccessChallenge: () => {},
    discoverSourceCandidates: () => ({ candidates: [article] }),
    isVisibleInViewport: () => true, updateCaptureProgress: () => {},
    findPermalinkDetails: () => null, waitForValue: () => null,
    expandSourceContent: () => null, restoreSourceContent: () => {},
    extractBlock: () => ({ text: fixture.text ?? "", author: "Owner", platformId: `x:status:${owner()}`, media: findMedia() }),
    findMedia, delay: async milliseconds => { delays.push(milliseconds); },
    compactText: value => String(value ?? "").trim(),
    normalizeCandidateDiagnostics: () => null,
    readScrollPosition: () => ({ y: 0 }), viewportHeight: () => 900,
  });
  for (const file of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/x-adapter.js",
    "bounded-capture-policy.js", "capture-quality-policy.js", "media-post-processor.js", "media-acquisition-engine.js"]) {
    runScript(context, file);
  }
  Object.assign(context, {
    sourceAdapters: context.AkuSourceAdapters, capturePolicy: context.AkuBoundedCapturePolicy,
    qualityPolicy: context.AkuCaptureQualityPolicy, mediaPostProcessor: context.AkuMediaPostProcessor,
    mediaAcquisitionEngine: context.AkuMediaAcquisitionEngine,
  });
  const source = fs.readFileSync(path.join(projectRoot, "content-script.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("  async function captureVisibleSnapshot("),
    source.indexOf("  function assertNoXAccessChallenge(")), context);
  vm.runInContext(source.slice(source.indexOf("  function evaluateBlockQuality("),
    source.indexOf("  function extractBlock(")), context);
  const snapshot = await context.captureVisibleSnapshot("x",
    { maxBlocksPerSnapshot: 3, qualityRetryBudget: fixture.retryBudget ?? 1, qualityRetrySettleMs: 700 },
    null, Date.now() + (fixture.timeLeft ?? 5_000), "same_window", null);
  return { snapshot, delays };
}

test("media acquisition awaits one source-specific structured media lookup", async () => {
  let resolved = false;
  const context = runtimeContext(() => [], {
    expectedKinds: ["video"],
    extractStructuredCandidates: async (_container, { candidateId }) => {
      assert.equal(candidateId, "linkedin:activity:7490315383795568640");
      await Promise.resolve();
      resolved = true;
      return [media("https://media.licdn.com/dms/image/v2/example/videocover-low/poster.jpg", "video")];
    },
  });
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "linkedin",
    container: {},
    candidateId: "linkedin:activity:7490315383795568640",
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 0,
    extractPrimary: () => [],
    delay: async () => {},
  });
  assert.equal(resolved, true);
  assert.equal(result.audit.outcome, "recovered");
  assert.equal(result.audit.method, "structured_state");
  assert.equal(result.media.length, 1);
});

test("media acquisition retries primary hydration before adapter fallback", async () => {
  const context = runtimeContext(() => {
    throw new Error("adapter fallback must not run after primary hydration");
  });
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [media("https://pbs.twimg.com/media/hydrated.jpg")],
    delay: async () => {},
  });
  assert.equal(result.audit.outcome, "recovered");
  assert.equal(result.audit.method, "primary_hydration");
  assert.equal(result.media.length, 1);
  assert.deepEqual(
    [...result.audit.trace],
    ["primary_missing", "media_root_detected", "structured_state_empty", "primary_hydration_complete"],
  );
});

test("media acquisition honors the bounded-load settle override", async () => {
  const delays = [];
  const context = runtimeContext(() => []);
  await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    settleMs: 1_000,
    extractPrimary: () => [],
    delay: async (milliseconds) => delays.push(milliseconds),
  });
  assert.deepEqual(delays, [1_000]);
});

test("media acquisition uses one adapter-specific alternate extraction", async () => {
  const context = runtimeContext(() => [media("https://pbs.twimg.com/media/alternate.jpg")]);
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [],
    delay: async () => {},
  });
  assert.equal(result.audit.outcome, "recovered");
  assert.equal(result.audit.method, "alternate_dom");
  assert.equal(result.audit.attempts, 1);
  assert.deepEqual(
    [...result.audit.trace],
    [
      "primary_missing",
      "media_root_detected",
      "structured_state_empty",
      "primary_hydration_empty",
      "alternate_dom_complete",
    ],
  );
});

test("media acquisition fails soft with an explicit unavailable outcome", async () => {
  const context = runtimeContext(() => []);
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "linkedin",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [],
    delay: async () => {},
  });
  assert.equal(result.audit.outcome, "unavailable");
  assert.match(result.audit.limitation, /remained unavailable/i);
  assert.deepEqual(
    [...result.audit.trace],
    [
      "primary_missing",
      "media_root_detected",
      "structured_state_empty",
      "primary_hydration_empty",
      "alternate_dom_empty",
    ],
  );
});

test("media acquisition summaries expose bounded stage counts", async () => {
  const context = runtimeContext(() => []);
  const recovery = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [],
    delay: async () => {},
  });
  const summary = context.AkuMediaAcquisitionEngine.summarize([recovery.audit]);
  assert.equal(summary.stageCounts.primary_missing, 1);
  assert.equal(summary.stageCounts.alternate_dom_empty, 1);
  assert.equal(summary.expectedKindCounts.image, 1);
});

test("quiet acquisition exhausts bounded background paths before requiring foreground", async () => {
  const delays = [];
  const context = runtimeContext(() => [], {
    quietRecovery: "bounded_dom",
    foregroundAfterQuietExhaustion: true,
    expectedKinds: ["video"],
  });
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    captureVisibilityMode: "managed_window",
    extractPrimary: () => [],
    delay: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(result.audit.outcome, "unavailable");
  assert.equal(result.audit.foregroundRequired, true);
  assert.equal(result.audit.visibilityRequirement, "foreground_window");
  assert.equal(result.audit.attempts, 1);
  assert.deepEqual(delays, [100]);
  assert.ok(result.audit.trace.includes("primary_hydration_empty"));
  assert.ok(result.audit.trace.includes("alternate_dom_empty"));
});

test("alternate DOM recovery reads lazy srcset and descendant computed backgrounds", async () => {
  const background = {
    backgroundImage: 'url("https://pbs.twimg.com/media/background.jpg")',
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const image = {
    currentSrc: "",
    src: "",
    srcset: "https://pbs.twimg.com/media/srcset-small.jpg 1x, https://pbs.twimg.com/media/srcset-large.jpg 2x",
    alt: "Recovered image",
    getAttribute(name) { return name === "srcset" ? this.srcset : ""; },
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const root = {
    matches: () => false,
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "video") return [];
      if (selector === "*") return [background];
      return [];
    },
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  };
  const context = runtimeContext((_container, { collectRootCandidates }) =>
    collectRootCandidates(root), {
      getComputedStyle: (element) => ({ backgroundImage: element.backgroundImage ?? "none" }),
      mediaUrlFromCssBackground: (value) => value.match(/https:\/\/[^"')]+/)?.[0] ?? null,
    });
  const result = await context.AkuMediaAcquisitionEngine.acquire({
    source: "x",
    container: {},
    initialMedia: [],
    mediaRootDetected: true,
    attemptsAvailable: 1,
    extractPrimary: () => [],
    delay: async () => {},
  });
  assert.equal(result.audit.method, "alternate_dom");
  assert.deepEqual(
    [...result.media].map((entry) => entry.url),
    [
      "https://pbs.twimg.com/media/srcset-small.jpg",
      "https://pbs.twimg.com/media/srcset-large.jpg",
      "https://pbs.twimg.com/media/background.jpg",
    ],
  );
});

test("X adapter fallback covers the captured regression shapes", () => {
  const context = adapterContext();
  runScript(context, path.join("adapters", "x-adapter.js"));
  const strategy = context.adapter.mediaAcquisition;
  const photoPermalinkSelector = 'a[href*="/status/"][href*="/photo/"]';
  assert.ok(context.adapter.qualitySelectors.media.includes(photoPermalinkSelector));
  assert.ok(context.adapter.imageSelector.includes(`${photoPermalinkSelector} img`));
  assert.ok(context.adapter.qualitySelectors.media.includes("twitterArticleReadView"));
  assert.ok(context.adapter.imageSelector.includes("twitterArticleReadView"));
  for (const fixture of cases) {
    const root = recoveryRoot(fixture);
    const container = {
      querySelectorAll(selector) {
        if (fixture.rootType === "photo" && selector.includes("tweetPhoto")) return [root];
        if (
          fixture.rootType === "photo_permalink" &&
          selector.includes('href*="/photo/"')
        ) return [root];
        if (fixture.rootType === "video" && selector.includes("previewInterstitial")) return [root];
        if (fixture.rootType === "card" && selector.includes("a[aria-label]")) return [root];
        if (fixture.rootType === "article" && selector.includes("twitterArticleReadView")) return [root];
        return [];
      },
    };
    const recovered = strategy.extractCandidates(container, {
      excludeRoot: null,
      uniqueElements: (values) => [...new Set(values)],
      collectRootCandidates(candidateRoot, { kind }) {
        return candidateRoot.urls.map((url) => media(url, kind));
      },
    });
    assert.equal(recovered.length, fixture.urls.length, fixture.id);
    assert.ok(recovered.every((entry) => entry.kind === fixture.expectedKind), fixture.id);
  }
});

function runtimeContext(extractCandidates, options = {}) {
  const adapter = {
    mediaHosts: ["pbs.twimg.com", "video.twimg.com"],
    mediaAcquisition: {
      version: "fixture-media-v1",
      maxAttempts: 1,
      settleMs: 100,
      quietRecovery: options.quietRecovery ?? "bounded_dom",
      foregroundAfterQuietExhaustion: options.foregroundAfterQuietExhaustion === true,
      detectExpectedKinds() { return options.expectedKinds ?? ["image"]; },
      extractStructuredCandidates: options.extractStructuredCandidates,
      extractCandidates,
    },
  };
  const context = {
    URL,
    AkuSourceAdapters: { get: () => adapter },
    AkuBoundedCapturePolicy: {
      normalizeMediaCandidates: (_source, values) => values.filter((entry) => entry?.url),
      mediaUrlFromCssBackground: options.mediaUrlFromCssBackground ?? (() => null),
    },
    getComputedStyle: options.getComputedStyle ?? (() => ({ backgroundImage: "none" })),
  };
  context.globalThis = context;
  const sandbox = vm.createContext(context);
  if (options.useRealPolicy) {
    delete context.AkuBoundedCapturePolicy;
    runScript(sandbox, "bounded-capture-policy.js");
  }
  runScript(sandbox, "media-post-processor.js");
  runScript(sandbox, "media-acquisition-engine.js");
  return sandbox;
}

function adapterContext() {
  const context = {
    AkuSourceAdapters: {
      register(adapter) { context.adapter = adapter; },
    },
  };
  context.globalThis = context;
  return vm.createContext(context);
}

function recoveryRoot(fixture) {
  const video = fixture.rootType === "video";
  return {
    urls: fixture.urls,
    matches: () => video,
    closest: () => video ? {} : null,
    getAttribute: () => "",
  };
}

function media(url, kind = "image") {
  return {
    kind,
    url,
    posterUrl: kind === "video" ? url : null,
    width: 640,
    height: 360,
  };
}

function runScript(context, file) {
  if (file === path.join("adapters", "x-adapter.js") && !context.AkuCapturePrimitives) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, "capture-primitives.js"), "utf8"), context);
  }
  vm.runInContext(fs.readFileSync(path.join(projectRoot, file), "utf8"), context);
}
