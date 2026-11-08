import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

class Article {
  constructor({ primary = false, author = "", text = "", permalink = "", media = false } = {}) {
    Object.assign(this, { primary, author, text, permalink, media });
  }

  getBoundingClientRect() {
    return { top: 10, bottom: 100, left: 10, right: 200, width: 190, height: 90 };
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
  ]);
  const readiness = probe();
  assert.equal(readiness.state, "feed_hydrating");
  assert.equal(readiness.diagnosis, "post_evidence_unhydrated");
  assert.equal(readiness.visibleStructuralCandidateCount, 3);
  assert.equal(readiness.visibleSelectorCandidateCount, 0);
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
});
