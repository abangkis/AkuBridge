import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { AkuBridgeError, createTabLease, serializeBridgeError } from "../bridge-runtime-policy.js";

class Article {
  constructor({ primary = false, author = "", text = "", permalink = "", media = false, visible = true } = {}) {
    Object.assign(this, { primary, author, text, permalink, media, visible });
  }

  getBoundingClientRect() {
    const top = this.visible ? 10 : 700;
    return { top, bottom: top + 90, left: 10, right: 200, width: 190, height: 90 };
  }

  querySelectorAll(selector) {
    if (selector === "time" && this.permalink) return [{ closest: () => ({ href: this.permalink }) }];
    if (selector === '[data-testid="User-Name"]' && this.author) return [{ innerText: this.author }];
    if (selector.includes('[data-testid="tweetText"]') && this.text) return [{ innerText: this.text }];
    if (selector === '[data-testid="tweetPhoto"]' && this.media) return [{}];
    return [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
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
    AkuBoundedCapturePolicy: {},
    AkuCaptureQualityPolicy: {},
    AkuSourceFreshnessRuntime: {},
    AkuMediaAcquisitionEngine: {},
    AkuMediaPostProcessor: { createDeferredInbox: () => ({}) },
  });
  for (const file of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/x-adapter.js", "content-script.js"]) {
    vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  return () => {
    let result;
    receive({ type: "AKU_BROWSER_PROBE_SOURCE_READY", source: "x" }, null, (value) => { result = value; });
    assert.equal(result.ok, true);
    return result.readiness;
  };
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
