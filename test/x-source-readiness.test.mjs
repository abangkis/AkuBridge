import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { AkuBridgeError, createTabLease, serializeBridgeError } from "../bridge-runtime-policy.js";
import { emptyCaptureDiagnostics } from "../capture-observation-policy.js";

class Article {
  constructor({ primary = false, author = "", text = "", permalink = "", media = false, visible = true,
    wrapperHref = "", profileHref = "", quote = null } = {}) {
    Object.assign(this, { primary, author, text, permalink, media, visible, wrapperHref, profileHref, quote });
    this.tagName = "ARTICLE";
    if (wrapperHref) {
      this.parentElement = {
        matches: (selector) => selector === '[role="link"][data-href]',
        getAttribute: (name) => name === "data-href" ? wrapperHref : null,
        closest: (selector) => selector === "article" ? this.outerArticle ?? null : null,
      };
      this.authorAnchor = { innerText: author, href: profileHref };
      this.body = { innerText: text, querySelectorAll: () => [] };
    }
    if (quote) quote.outerArticle = this;
  }

  getBoundingClientRect() {
    const top = this.visible ? 10 : 700;
    return { top, bottom: top + 90, left: 10, right: 200, width: 190, height: 90 };
  }

  querySelectorAll(selector) {
    if (selector === "time" && this.permalink) return [{ closest: () => ({ href: this.permalink }) }];
    if (selector === "article") return this.quote ? [this.quote] : [];
    if (this.wrapperHref) {
      if (selector === '.x-middot-group a[href]') {
        return [this.authorAnchor, this.quote?.authorAnchor].filter(Boolean);
      }
      if (selector.includes('div[dir="auto"].whitespace-pre-wrap')) {
        return [this.body, this.quote?.body].filter((body) => body?.innerText);
      }
      return [];
    }
    if (selector === '[data-testid="User-Name"]' && this.author) return [{ innerText: this.author }];
    if (selector.includes('[data-testid="tweetText"]') && this.text) return [{ innerText: this.text }];
    if (selector === '[data-testid="tweetPhoto"]' && this.media) return [{}];
    return [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getAttribute() { return null; }

  contains(element) {
    return element === this || element === this.body || element === this.authorAnchor ||
      Boolean(this.quote?.contains(element));
  }
}

function createProbe(articles, { entries = [], url = "https://x.com/home", subframe = false } = {}) {
  const document = {
    readyState: "complete",
    body: {},
    querySelector: (selector) => selector === "main" ? {} : null,
    querySelectorAll(selector) {
      if (selector === 'article[data-testid="tweet"]') return articles.filter((article) => article.primary);
      return selector === "main article" ? articles : [];
    },
  };
  const window = { location: new URL(url), innerWidth: 800, innerHeight: 600 };
  window.top = subframe ? {} : window;
  let receive;
  const context = vm.createContext({
    URL,
    document,
    window,
    performance: { getEntriesByType: (type) => type === "navigation" ? entries : [] },
    navigator: {
      userAgent: "Private browser fields Chrome/157.0.0.0",
      userAgentData: { brands: [{ brand: "Chromium", version: "157" }] },
    },
    Element: Article,
    getComputedStyle: () => ({ opacity: "1", visibility: "visible", display: "block" }),
    chrome: { runtime: { onMessage: { addListener: (listener) => { receive = listener; } } } },
    AkuCaptureQualityPolicy: {},
    AkuSourceFreshnessRuntime: {},
    AkuMediaAcquisitionEngine: {},
    AkuMediaPostProcessor: { createDeferredInbox: () => ({}) },
  });
  for (const file of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/x-adapter.js",
    "bounded-capture-policy.js", "content-script.js"]) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const fixtureSource = file === "content-script.js"
      ? source.replace(/\}\)\(\);\s*$/, "  globalThis.extractFixtureBlock = extractBlock;\n})();")
      : source;
    vm.runInContext(fixtureSource, context, { filename: file });
  }
  const probe = () => {
    let result;
    receive({ type: "AKU_BROWSER_PROBE_SOURCE_READY", source: "x" }, null, (value) => { result = value; });
    assert.equal(result.ok, true);
    return result.readiness;
  };
  probe.extract = (article) => context.extractFixtureBlock(article, "x", 4_000, context.window);
  return probe;
}

test("Windowed X reports an allowlisted main-document response, including HTTP 403", () => {
  const url = "https://x.com/home?private=query";
  const entry = {
    name: url,
    responseStatus: 403,
    nextHopProtocol: "h2",
    type: "navigate",
    redirectCount: 0,
    workerStart: 0,
    headers: { Cookie: "private-cookie" },
  };
  const result = createProbe([], { url, entries: [entry] })();
  assert.deepEqual({ ...result.windowedNavigation }, {
    state: "matched",
    httpStatus: 403,
    httpStatusSource: "navigation_timing",
    protocol: "h2",
    navigationType: "navigate",
    redirectCount: 0,
    serviceWorkerInvolved: false,
    userAgentHeadless: false,
    clientHintsHeadless: false,
  });
  assert.doesNotMatch(JSON.stringify(result.windowedNavigation), /private|cookie|x\.com/i);
  assert.equal(result.state, createProbe([], { url })().state);
});

test("Windowed X does not infer a status or attribute a different navigation to /home", () => {
  const url = "https://x.com/home";
  const entry = {
    name: url,
    responseStatus: 0,
    nextHopProtocol: "arbitrary",
    redirectCount: 100,
    deliveryType: "cache",
  };
  const unknown = createProbe([], { entries: [entry] })().windowedNavigation;
  assert.deepEqual({ ...unknown }, {
    state: "matched",
    httpStatusSource: "not_observed",
    deliveryType: "cache",
    userAgentHeadless: false,
    clientHintsHeadless: false,
  });
  const otherDocument = createProbe([], {
    entries: [{ ...entry, name: "https://x.com/other", responseStatus: 200 }],
  })().windowedNavigation;
  assert.deepEqual({ ...otherDocument }, { state: "not_observed" });
  assert.equal(createProbe([], { entries: [entry], subframe: true })().windowedNavigation, undefined);
});

test("visible X placeholders remain structural candidates and do not mark the feed ready", () => {
  const probe = createProbe([
    new Article(),
    new Article({ primary: true, author: "Author", permalink: "https://x.com/author/status/123" }),
    new Article({ text: "Post body without an author" }),
    new Article({ author: "Media author", media: true }),
    new Article({ visible: false }),
  ]);
  const readiness = probe();
  assert.equal(readiness.state, "feed_hydrating");
  assert.equal(readiness.diagnosis, "post_evidence_unhydrated");
  assert.equal(readiness.structuralCandidateCount, 5);
  assert.equal(readiness.visibleStructuralCandidateCount, 4);
  assert.equal(readiness.visibleSelectorCandidateCount, 0);
  assert.deepEqual({ ...readiness.candidateRejections }, {
    visibleRejected: 4, missingAuthor: 2, missingText: 3, missingMediaOrQuote: 2, missingPermalink: 2,
  });
});

test("a subsequent X readiness probe admits a post after its author and content hydrate", () => {
  const article = new Article({ primary: true });
  const probe = createProbe([article]);
  assert.equal(probe().state, "feed_hydrating");
  article.author = "Author";
  assert.equal(probe().state, "feed_hydrating");
  article.text = "Hydrated post body";
  assert.equal(probe().state, "feed_ready");
  assert.equal(probe().visibleSelectorCandidateCount, 1);
  assert.equal(probe().candidateRejections.visibleRejected, 0);
});

test("X readiness preserves real alternative markup and media-only posts", () => {
  const probe = createProbe([
    new Article({ author: "Text author", text: "Post body without the tweet article marker" }),
    new Article({ author: "Media author", permalink: "https://x.com/author/status/123", media: true }),
    new Article(),
  ]);
  const readiness = probe();
  assert.equal(readiness.state, "feed_ready");
  assert.equal(readiness.visibleStructuralCandidateCount, 3);
  assert.equal(readiness.visibleSelectorCandidateCount, 2);
  assert.deepEqual({ ...readiness.candidateRejections }, {
    visibleRejected: 1, missingAuthor: 1, missingText: 1, missingMediaOrQuote: 1, missingPermalink: 1,
  });
});

test("Windowed X extracts a wrapped post and quote as separate identities and text", () => {
  const quote = new Article({ wrapperHref: "https://x.com/quoted/status/456", profileHref: "https://x.com/quoted",
    author: "Quoted author", text: "Quoted words" });
  const owner = new Article({ wrapperHref: "/owner/status/123", profileHref: "https://x.com/owner",
    author: "Owner name", text: "Owner words", quote });
  const probe = createProbe([owner, quote]);
  const readiness = probe();
  assert.equal(readiness.state, "feed_ready");
  assert.equal(readiness.structuralCandidateCount, 1);
  assert.equal(readiness.visibleSelectorCandidateCount, 1);
  const block = probe.extract(owner);
  assert.equal(block.author, "Owner name");
  assert.equal(block.text, "Owner words");
  assert.equal(block.permalink, "https://x.com/owner/status/123");
  assert.equal(block.platformId, "x:status:123");
  assert.equal(block.presentation.primaryIdentity.status, "identified");
  assert.equal(block.publishedAt, null);
  assert.equal(block.relationshipType, "quote");
  assert.equal(block.quotedPost.author, "Quoted author");
  assert.equal(block.quotedPost.text, "Quoted words");
  assert.equal(block.quotedPost.permalink, "https://x.com/quoted/status/456");
  assert.equal(block.directContext[0].target.id, "456");
});

test("a wrapper URL alone cannot admit a placeholder or let a quote stand in for its author", () => {
  const quote = new Article({ wrapperHref: "/quoted/status/456", profileHref: "https://x.com/quoted",
    author: "Quoted author", text: "Quoted words" });
  const articles = [
    new Article({ wrapperHref: "/empty/status/111", profileHref: "https://x.com/empty", author: "Empty author" }),
    new Article({ wrapperHref: "/owner/status/123", quote }),
    quote,
    new Article({ wrapperHref: "https://x.com.evil.test/fake/status/789", profileHref: "https://x.com/fake",
      author: "Fake author", text: "Fake body" }),
  ];
  const readiness = createProbe(articles)();
  assert.equal(readiness.state, "feed_hydrating");
  assert.equal(readiness.visibleSelectorCandidateCount, 0);
  assert.equal(readiness.candidateRejections.visibleRejected, 3);
});

test("X readiness timeout sends numeric rejection counts in the Bridge failure", async () => {
  const privateURL = "https://private.example/post?token=private";
  const probe = createProbe([new Article({ author: "Private author", media: true, permalink: privateURL })], {
    entries: [{ name: "https://x.com/home", responseStatus: 403 }],
  });
  const service = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const preparation = service.slice(service.indexOf("async function prepareSourceTab("),
    service.indexOf("async function collectStructuredFeedFallback("));
  const readyCheck = service.slice(service.indexOf("function isSourceCaptureReady("),
    service.indexOf("async function assertTabLease("));
  const navigationProjection = service.slice(service.indexOf("function windowedNavigationForTab("),
    service.indexOf("async function capturePreparedSource("));
  const context = vm.createContext({
    AkuBridgeError, createTabLease,
    sourceDefinition: () => ({}),
    sourceRequiresVisualHydration: () => true,
    sourceHydrationTimeout: () => 12_000,
    waitForSourceReady: async () => probe(),
    collectStructuredFeedFallback: async () => null,
    restoreTabFocus: async () => {},
    sourceLabel: () => "X",
  });
  vm.runInContext(navigationProjection + preparation + readyCheck, context);
  await assert.rejects(context.prepareSourceTab({ id: 1, windowId: 2, active: true, url: "https://x.com/home" }, "x", true), (error) => {
    const body = JSON.stringify(serializeBridgeError(error));
    const failure = JSON.parse(body);
    assert.equal(failure.code, "source_readiness_failed");
    assert.equal(failure.stage, "readiness");
    assert.match(failure.message, /rejected=1, missing-author=0, missing-text=1, missing-media-or-quote=0, missing-permalink=1/);
    assert.deepEqual(failure.details.readiness.candidateRejections, {
      visibleRejected: 1, missingAuthor: 0, missingText: 1, missingMediaOrQuote: 0, missingPermalink: 1,
    });
    assert.equal(failure.details.windowedNavigation.httpStatus, 403);
    assert.equal(failure.details.windowedNavigation.tabOpenedForCapture, true);
    assert.doesNotMatch(body, /private/i);
    return true;
  });
});

test("Windowed X carries navigation diagnostics through the capture result and failure", async () => {
  const readiness = createProbe([], {
    entries: [{ name: "https://x.com/home", responseStatus: 200, nextHopProtocol: "h3" }],
  })();
  let captureError;
  const service = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const capture = service.slice(service.indexOf("async function captureWithSourceTabRecovery("),
    service.indexOf("async function capturePreparedSource("));
  const context = vm.createContext({
    chrome: {},
    sourceAccessGranted: async () => true,
    findOrOpenSourceTab: async () => ({ readiness, opened: false, restoreFocus: async () => ({}) }),
    capturePreparedSource: async () => {
      if (captureError) throw captureError;
      return { coverage: {} };
    },
    observationEvidenceBlockCount: () => 1,
    shouldCloseOpenedSourceTab: () => false,
    shouldRetrySourceTab: () => false,
    sourceDefinition: () => ({}),
  });
  vm.runInContext(capture, context);
  const command = { payload: { source: "x" } };
  const { coverage } = await context.captureWithSourceTabRecovery(command);
  assert.equal(coverage.windowedNavigation.httpStatus, 200);
  assert.equal(coverage.windowedNavigation.tabOpenedForCapture, false);
  const followUp = await context.captureWithSourceTabRecovery({ payload: { source: "x", acquisitionRound: 2 } });
  assert.equal(followUp.coverage.windowedNavigation, undefined);
  captureError = new AkuBridgeError("freshness_unavailable", "source_freshness", "Fixture error", { existing: true });
  await assert.rejects(context.captureWithSourceTabRecovery(command), (error) => {
    const failure = serializeBridgeError(error);
    assert.equal(failure.stage, "source_freshness");
    assert.equal(failure.details.existing, true);
    assert.equal(failure.details.windowedNavigation.httpStatus, 200);
    return true;
  });
});

test("Windowed X recapture records only the final tab route category before closing the tab", async () => {
  const service = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const capture = service.slice(service.indexOf("async function captureWithSourceTabRecovery("),
    service.indexOf("async function capturePreparedSource("));
  const targetUrl = "https://x.com/owner/status/12345";
  let tabUrl, closed, empty, selection;
  const context = vm.createContext({
    URL, AkuBridgeError,
    chrome: { tabs: {
      get: async () => {
        assert.equal(closed, false);
        if (!tabUrl) throw new Error("tab closed");
        return { url: tabUrl };
      },
      remove: async () => { closed = true; },
    } },
    sourceAccessGranted: async () => true,
    findOrOpenSourceTab: async () => ({ tab: { id: 17 }, opened: true, restoreFocus: async () => ({}) }),
    capturePreparedSource: async () => ({
      pageUrl: targetUrl + "?private_query=1",
      coverage: {},
      snapshots: selection ? [{ xRecaptureSelection: selection }] : [],
    }),
    observationEvidenceBlockCount: () => empty ? 0 : 1,
    emptyCaptureDiagnostics,
    shouldCloseOpenedSourceTab: () => true,
    shouldRetrySourceTab: () => false,
    sourceDefinition: () => ({}),
  });
  vm.runInContext(capture, context);
  const command = { type: "recapture_media", payload: { source: "x", targetUrl } };
  for (const [url, expected, from = "tab"] of [
    ["https://x.com/i/web/status/12345?private_query=1#fragment", "target_status"],
    ["https://x.com/other/status/67890", "other_status"],
    ["https://x.com/home?private_query=1", "feed"],
    ["https://x.com/i/flow/login?private_query=1", "login"],
    ["https://x.com/account/access", "challenge"],
    ["https://x.com.evil.example/home", "outside_x"],
    [null, "target_status", "observation"],
  ]) {
    tabUrl = url;
    closed = false;
    const result = await context.captureWithSourceTabRecovery(command);
    assert.equal(JSON.stringify(result.coverage.xRecaptureRoute), JSON.stringify({ source: from, kind: expected }));
    assert.equal(closed, true);
  }
  tabUrl = "https://x.com/home";
  empty = true;
  closed = false;
  await assert.rejects(context.captureWithSourceTabRecovery(command), error => {
    assert.equal(error.code, "capture_empty");
    assert.equal(error.details.xRecaptureRoute.kind, "feed");
    return true;
  });
  selection = { outcome: "target_not_identified", targetMatchCount: 0 };
  await assert.rejects(context.captureWithSourceTabRecovery(command), error => {
    const failure = serializeBridgeError(error);
    assert.equal(failure.code, "recapture_target_not_observed");
    assert.deepEqual(failure.details.xRecaptureSelection, selection);
    assert.equal(failure.details.xRecaptureRoute.kind, "feed");
    return true;
  });
});

test("Windowed X recapture selects the exact article before the normal candidate cap", async () => {
  const target = new Article({ wrapperHref: "/owner/status/12345" });
  const replies = Array.from({ length: 6 }, (_, index) => new Article({
    primary: true, permalink: `https://x.com/reply/status/${67890 + index}`,
  }));
  const { snapshot, extracted, delays } = await captureXRecaptureFixture([...replies, target]);
  assert.deepEqual(extracted, [target]);
  assert.deepEqual(delays, []);
  assert.equal(snapshot.blocks[0].platformId, "x:status:12345");
  assert.equal(snapshot.xRecaptureSelection.outcome, "target_captured");
  assert.equal(snapshot.xRecaptureSelection.scannedCount, 7);
});

test("Windowed X recapture reports why the target could not be admitted", async () => {
  const target = new Article({ wrapperHref: "/owner/status/12345" });
  const other = new Article({ wrapperHref: "/other/status/67890" });
  const quote = new Article({ wrapperHref: "/owner/status/12345" });
  const quoting = new Article({ wrapperHref: "/other/status/67890", quote });
  const conflicting = new Article({ wrapperHref: "/owner/status/12345", permalink: "https://x.com/other/status/67890" });
  for (const [candidates, options, outcome, delays] of [
    [[other, quoting, quote, conflicting], {}, "target_not_identified", [150]],
    [[new Article({ wrapperHref: "/owner/status/12345", visible: false })], {}, "target_not_visible", []],
    [[target, new Article({ wrapperHref: "/owner/status/12345" })], {}, "ambiguous_target", []],
    [[target], { pageURL: "https://x.com/home" }, "target_route_mismatch", []],
    [[target], { invalidQuality: true }, "target_quality_rejected", []],
    [[target], { routeChanges: true }, "target_route_mismatch", []],
    [[target], { identityChanges: true }, "target_identity_changed", []],
  ]) {
    const result = await captureXRecaptureFixture(candidates, options);
    assert.equal(result.snapshot.blocks.length, 0, outcome);
    assert.equal(result.snapshot.xRecaptureSelection.outcome, outcome);
    assert.deepEqual(result.delays, delays, outcome);
    if (outcome === "target_not_identified") {
      assert.equal(result.snapshot.xRecaptureSelection.conflictingIdentityCount, 1);
      assert.equal(result.extracted.length, 0);
    }
  }
  const late = await captureXRecaptureFixture([other], { afterDelay: [other, target] });
  assert.deepEqual(late.delays, [150]);
  assert.deepEqual(late.extracted, [target]);
  assert.equal(late.snapshot.xRecaptureSelection.outcome, "target_captured");
  assert.equal(late.snapshot.xRecaptureSelection.rescanned, true);
});

async function captureXRecaptureFixture(candidates, options = {}) {
  const targetURL = "https://x.com/owner/status/12345";
  const extracted = [], delays = [];
  const context = vm.createContext({
    URL,
    window: { location: new URL(options.pageURL ?? targetURL) },
    document: { querySelectorAll: selector => (delays.length && options.afterDelay || candidates)
      .filter(article => selector !== 'article[data-testid="tweet"]' || article.primary) },
    isVisibleInViewport: article => article.visible,
    assertNoXAccessChallenge: () => {}, updateCaptureProgress: () => {},
    findPermalinkDetails: () => null, waitForValue: () => null,
    expandSourceContent: () => null, restoreSourceContent: () => {},
    compactText: value => String(value ?? "").trim(),
    uniqueElements: values => [...new Set(values)],
    delay: async milliseconds => { delays.push(milliseconds); },
    normalizeCandidateDiagnostics: () => null,
    readScrollPosition: () => ({ y: 0 }), viewportHeight: () => 900,
    mediaAcquisitionEngine: {
      observe: () => null,
      acquire: async () => ({ media: [], audit: { outcome: "not_applicable" } }),
    },
    mediaPostProcessor: { withPlaybackStatus: (_source, _media, audit) => audit },
    evaluateBlockQuality: () => ({ verdict: options.invalidQuality ? "invalid" : "complete", evidenceModalities: ["text"], issues: [] }),
    extractBlock: article => {
      extracted.push(article);
      if (options.routeChanges) context.window.location = new URL("https://x.com/home");
      const permalink = options.identityChanges ? "https://x.com/other/status/67890"
        : context.AkuSourceAdapters.get("x").resolveIdentity(article).permalink;
      return { permalink, platformId: context.AkuSourceAdapters.get("x").platformIdFromCandidates([permalink]), media: [] };
    },
  });
  for (const file of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/x-adapter.js",
    "shared-dom-engine/browser-runtime.js", "adapters/x-dom-shadow.js"]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context);
  }
  context.sourceAdapters = context.AkuSourceAdapters;
  const source = fs.readFileSync(new URL("../content-script.js", import.meta.url), "utf8");
  for (const [start, end] of [
    ["  async function captureVisibleSnapshot(", "  function assertNoXAccessChallenge("],
    ["  function admittedBlockKey(", "  function selectorDetectedOutside("],
    ["  function discoverSourceCandidates(", "  function sourceMatchesPage("],
  ]) {
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  }
  const snapshot = await context.captureVisibleSnapshot("x", {
    maxBlocksPerSnapshot: 5, qualityRetryBudget: 1, qualityRetrySettleMs: 150, recaptureTarget: targetURL,
  }, null, Date.now() + 3_000, "managed_window", null);
  return { snapshot, extracted, delays };
}
