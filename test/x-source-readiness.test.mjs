import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { AkuBridgeError, createTabLease, serializeBridgeError } from "../bridge-runtime-policy.js";

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

function createProbe(articles) {
  const document = {
    readyState: "complete",
    body: {},
    querySelector: (selector) => selector === "main" ? {} : null,
    querySelectorAll(selector) {
      if (selector === 'article[data-testid="tweet"]') return articles.filter((article) => article.primary);
      return selector === "main article" ? articles : [];
    },
  };
  let receive;
  const context = vm.createContext({
    URL,
    document,
    window: { location: new URL("https://x.com/home"), innerWidth: 800, innerHeight: 600 },
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
  const probe = createProbe([new Article({ author: "Private author", media: true, permalink: privateURL })]);
  const service = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  const preparation = service.slice(service.indexOf("async function prepareSourceTab("),
    service.indexOf("async function collectStructuredFeedFallback("));
  const readyCheck = service.slice(service.indexOf("function isSourceCaptureReady("),
    service.indexOf("async function assertTabLease("));
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
  vm.runInContext(preparation + readyCheck, context);
  await assert.rejects(context.prepareSourceTab({ id: 1, windowId: 2, active: true, url: "https://x.com/home" }, "x", true), (error) => {
    const body = JSON.stringify(serializeBridgeError(error));
    const failure = JSON.parse(body);
    assert.equal(failure.code, "source_readiness_failed");
    assert.equal(failure.stage, "readiness");
    assert.match(failure.message, /rejected=1, missing-author=0, missing-text=1, missing-media-or-quote=0, missing-permalink=1/);
    assert.deepEqual(failure.details.readiness.candidateRejections, {
      visibleRejected: 1, missingAuthor: 0, missingText: 1, missingMediaOrQuote: 0, missingPermalink: 1,
    });
    assert.doesNotMatch(body, /private/i);
    return true;
  });
});
