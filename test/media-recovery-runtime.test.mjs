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
    mediaAcquisition: {
      version: "fixture-media-v1",
      maxAttempts: 1,
      settleMs: 100,
      quietRecovery: options.quietRecovery ?? "bounded_dom",
      foregroundAfterQuietExhaustion: options.foregroundAfterQuietExhaustion === true,
      detectExpectedKinds() { return options.expectedKinds ?? ["image"]; },
      extractCandidates,
    },
  };
  const context = {
    AkuSourceAdapters: { get: () => adapter },
    AkuBoundedCapturePolicy: {
      normalizeMediaCandidates: (_source, values) => values.filter((entry) => entry?.url),
      mediaUrlFromCssBackground: options.mediaUrlFromCssBackground ?? (() => null),
    },
    getComputedStyle: options.getComputedStyle ?? (() => ({ backgroundImage: "none" })),
  };
  context.globalThis = context;
  const sandbox = vm.createContext(context);
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
  vm.runInContext(fs.readFileSync(path.join(projectRoot, file), "utf8"), context);
}
