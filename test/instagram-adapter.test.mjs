import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  isCanonicalFeed,
  isNativePostUrl,
  sourceDefinition,
  sourceForUrl,
} from "../source-catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Instagram is an independently permissioned source with bounded native URLs", () => {
  const definition = sourceDefinition("instagram");
  assert.equal(definition.adapterVersion, "instagram-dom-v4");
  assert.equal(sourceForUrl("https://www.instagram.com/"), "instagram");
  assert.equal(isCanonicalFeed("https://www.instagram.com/", "instagram"), true);
  assert.equal(isNativePostUrl("https://www.instagram.com/p/ABC_123/", "instagram"), true);
  assert.equal(isNativePostUrl("https://www.instagram.com/reel/Reel-123/", "instagram"), true);
  assert.equal(isNativePostUrl("https://www.instagram.com/explore/", "instagram"), false);
  assert.equal(isNativePostUrl("https://evil.example/p/ABC_123/", "instagram"), false);
});

test("Instagram adapter captures a live-shaped Home Feed article without admitting ads", () => {
  const candidate = instagramCandidate();
  const ad = instagramCandidate({ permalink: null, author: "sponsored.account" });
  const document = {
    body: {},
    querySelector(selector) {
      if (selector === "main") return {};
      if (selector.includes('input[name="username"]')) return null;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "main article" ? [candidate, ad] : [];
    },
  };
  const window = {
    document,
    location: {
      hostname: "www.instagram.com",
      pathname: "/",
      href: "https://www.instagram.com/",
    },
  };
  const context = vm.createContext({ document, window, URL });
  context.globalThis = context;
  run(context, "bounded-capture-policy.js");
  run(context, "media-post-processor.js");
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/instagram-adapter.js");

  const adapter = context.AkuSourceAdapters.get("instagram");
  const helpers = {
    compactText,
    normalizeHttpUrl: (value) => /^https?:\/\//.test(value ?? "") ? value : null,
  };
  const discovery = adapter.discoverCandidates({ uniqueElements: (items) => [...new Set(items)] });

  assert.equal(adapter.version, "instagram-dom-v4");
  assert.equal(adapter.matchesPage(), true);
  assert.equal(adapter.loginRequired(), false);
  assert.equal(adapter.feedRootPresent(), true);
  assert.equal(discovery.strategy, "main_article_native_permalink");
  assert.equal(discovery.readinessCandidates.length, 2);
  assert.equal(discovery.candidates.length, 1);
  assert.equal(adapter.findAuthor(candidate, helpers), "aku.example");
  assert.equal(adapter.findAvatar(candidate, helpers), "https://instagram.fcgk4-2.fna.fbcdn.net/avatar.jpg");
  assert.equal(adapter.extractText(candidate, helpers), "A bounded Instagram caption with useful source evidence.");
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(candidate, helpers))), {
    url: "https://www.instagram.com/p/ABC_123/",
    source: "native_post_anchor",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.extractSemantics(candidate, helpers))), {
    contentKind: "post",
    relationshipType: "original",
    parentPermalink: null,
    engagement: { like: "1.2K", comment: "34" },
  });
  assert.equal(
    adapter.platformIdFromCandidates(["https://www.instagram.com/p/ABC_123/"]),
    "instagram:p:ABC_123",
  );
  assert.equal(adapter.structuredMediaEvidence.payloadField, "instagramStructuredMediaEvidence");
  assert.equal(adapter.structuredMediaEvidence.runtime().ingestStructured({
    candidates: [{
      candidateId: "instagram:post:ABC_123",
      media: [{
        kind: "video",
        posterUrl: "https://instagram.example.fbcdn.net/v/poster.jpg?token=poster",
        playbackUrl: "https://instagram.example.fbcdn.net/o1/video.mp4?token=video",
        width: 720,
        height: 1280,
        provenance: "instagram_structured_json",
      }],
    }],
  }), 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(adapter.mediaAcquisition.extractStructuredCandidates(candidate))),
    [{
      kind: "video",
      url: "https://instagram.example.fbcdn.net/v/poster.jpg?token=poster",
      posterUrl: "https://instagram.example.fbcdn.net/v/poster.jpg?token=poster",
      playbackUrl: "https://instagram.example.fbcdn.net/o1/video.mp4?token=video",
      playbackMode: "inline",
      width: 720,
      height: 1280,
      provenance: "instagram_structured_json",
      trustedMediaRoot: true,
      urlSource: "instagram_structured_json",
    }],
  );
  const readiness = adapter.assessReadiness({
    state: "feed_not_visible",
    feedRootPresent: true,
    documentReadyState: "complete",
    selectorCandidateCount: 1,
    visibleSelectorCandidateCount: 0,
    structuralCandidateCount: 2,
  });
  assert.equal(readiness.recovery.inPageAction, "align_first_candidate");
  assert.deepEqual(
    JSON.parse(JSON.stringify(adapter.recoverReadiness(readiness.recovery
      ? { recoveryHint: readiness.recovery }
      : {}))),
    { attempted: true, outcome: "candidate_aligned" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.lastScrollOptions)), {
    block: "start",
    inline: "nearest",
    behavior: "instant",
  });
});

test("Instagram adapter can anchor a candidate to a native permalink without an article tag", () => {
  const permalink = { href: "https://www.instagram.com/p/ABC_123/" };
  const card = {
    tagName: "div",
    parentElement: null,
    innerText: "aku.example 2h A bounded caption with enough visible evidence.",
    textContent: "aku.example 2h A bounded caption with enough visible evidence.",
    getAttribute() { return null; },
    querySelector(selector) {
      if (selector === "time") return { textContent: "2h" };
      if (selector === "img, video") return { currentSrc: "https://instagram.example/image.jpg" };
      if (selector === 'span[dir="auto"]') return { textContent: "A bounded caption" };
      return null;
    },
    querySelectorAll(selector) {
      return selector === "a[href]" ? [permalink] : [];
    },
  };
  permalink.parentElement = card;
  const main = {
    querySelectorAll(selector) {
      return selector === "a[href]" ? [permalink] : [];
    },
  };
  const document = {
    querySelector(selector) {
      return selector === "main" ? main : null;
    },
    querySelectorAll() { return []; },
  };
  const window = {
    document,
    location: {
      hostname: "www.instagram.com",
      pathname: "/",
      href: "https://www.instagram.com/",
    },
  };
  const context = vm.createContext({ document, window, URL });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/instagram-adapter.js");

  const adapter = context.AkuSourceAdapters.get("instagram");
  const discovery = adapter.discoverCandidates({ uniqueElements: (items) => [...new Set(items)] });

  assert.equal(discovery.strategy, "native_permalink_ancestor");
  assert.equal(discovery.readinessCandidates.length, 1);
  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.selectorCounts.native_permalink_ancestor, 1);
});

function instagramCandidate({ permalink = "https://www.instagram.com/p/ABC_123/", author = "aku.example" } = {}) {
  const avatar = {
    currentSrc: "https://instagram.fcgk4-2.fna.fbcdn.net/avatar.jpg",
    src: "https://instagram.fcgk4-2.fna.fbcdn.net/avatar.jpg",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "alt") return `${author}'s profile picture`;
      return null;
    },
  };
  const profile = {
    href: `https://www.instagram.com/${author}/`,
    innerText: author,
    textContent: author,
    querySelector(selector) {
      return selector.includes("profile picture") || selector === "img" ? avatar : null;
    },
  };
  const nativeLink = permalink ? { href: permalink } : null;
  const time = { textContent: "2h" };
  const authorSpan = {
    innerText: author,
    textContent: author,
    closest: () => null,
  };
  const caption = {
    innerText: "A bounded Instagram caption with useful source evidence. ... more",
    textContent: "A bounded Instagram caption with useful source evidence. ... more",
    closest: () => null,
  };
  const action = (label, text = "") => ({
    innerText: text,
    getAttribute: () => null,
    querySelector(selector) {
      return selector === "svg[aria-label]" && label
        ? { getAttribute: (name) => name === "aria-label" ? label : null }
        : null;
    },
  });
  const controls = [
    action("Like"),
    action(null, "1.2K"),
    action("Comment"),
    action(null, "34"),
    action("Share"),
  ];
  return {
    innerText: `${author}\n2h\n1.2K\n34\n${author}\n${caption.innerText}`,
    lastScrollOptions: null,
    getBoundingClientRect() {
      return { width: 470, height: 700 };
    },
    scrollIntoView(options) {
      this.lastScrollOptions = options;
    },
    querySelector(selector) {
      if (selector === "video") return null;
      if (selector === "time") return time;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href]") return [profile, nativeLink].filter(Boolean);
      if (selector === 'a[href^="/"]') return [profile];
      if (selector === 'span[dir="auto"]') return [authorSpan, caption];
      if (selector === '[role="button"], button') return controls;
      if (selector === "video" || selector.includes("img:not")) return [];
      return [];
    },
  };
}

function compactText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function run(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
