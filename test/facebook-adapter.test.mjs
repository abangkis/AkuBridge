import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  isCanonicalFeed,
  isNativePostUrl,
  sourceAdapterVersions,
  sourceForUrl,
  sourceMatchPatterns,
  sourceRuntimeScripts,
} from "../source-catalog.js";
import { registeredScriptsForSources } from "../source-access-policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("source catalog exposes Facebook without changing the X media capability", () => {
  assert.deepEqual(sourceAdapterVersions(), {
    x: "x-dom-v22",
    linkedin: "linkedin-dom-v20",
    facebook: "facebook-dom-v18",
    instagram: "instagram-dom-v2",
  });
  assert.equal(sourceForUrl("https://www.facebook.com/"), "facebook");
  assert.equal(isCanonicalFeed("https://www.facebook.com/", "facebook"), true);
  assert.equal(isNativePostUrl("https://www.facebook.com/example/posts/123456/", "facebook"), true);
  assert.equal(isNativePostUrl("https://evil.example/posts/123456/", "facebook"), false);
});

test("optional MV3 source authority stays synchronized with the generic source catalog", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const optionalHosts = new Set(manifest.optional_host_permissions);
  for (const pattern of sourceMatchPatterns()) {
    assert.equal(optionalHosts.has(pattern), true, `optional authority is missing ${pattern}`);
  }
  const contentFiles = new Set(registeredScriptsForSources(["x", "linkedin", "facebook", "instagram"])
    .flatMap((entry) => entry.js ?? []));
  for (const file of sourceRuntimeScripts()) {
    assert.equal(contentFiles.has(file), true, `registered source logic is missing ${file}`);
  }
});

test("Facebook adapter passes synthetic Home Feed conformance", () => {
  const candidate = facebookCandidate();
  const selector = '[role="feed"] > div [role="article"]';
  const document = {
    body: {},
    querySelector(value) { return value.includes("main") || value.includes('[role="feed"]') ? {} : null; },
    querySelectorAll(value) { return value === selector ? [candidate] : []; },
  };
  const context = vm.createContext({ document, window: { document, location: { hostname: "www.facebook.com", pathname: "/" } }, URL });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");
  const adapter = context.AkuSourceAdapters.get("facebook");
  const discovery = adapter.discoverCandidates({ uniqueElements: (items) => [...new Set(items)] });
  const helpers = { compactText, normalizeHttpUrl, structuredText: (element) => element?.innerText ?? "" };

  assert.equal(adapter.version, "facebook-dom-v18");
  assert.equal(adapter.captureTuning.scrollStepMultiplier, 2);
  assert.equal(adapter.captureTuning.scrollStrategy, "next_candidate");
  assert.deepEqual([...adapter.evidenceProfile.modalities], ["text", "image", "video", "attachment", "quoted_post"]);
  assert.equal(discovery.candidates.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(discovery.candidateDiagnostics)), {
    structuralCandidates: 1,
    eligibleCandidates: 1,
    actionAnchoredCandidates: 0,
    admittedReasons: { post_action_cluster: 1 },
    rejectedReasons: {},
  });
  assert.equal(adapter.findAuthor(candidate, helpers), "Aku Example");
  assert.equal(adapter.findAvatar(candidate, helpers), "https://scontent.fcgk1-2.fna.fbcdn.net/avatar.jpg");
  assert.equal(adapter.extractText(candidate, helpers), "A bounded Facebook Home Feed post with useful source evidence.");
  assert.equal(adapter.extractPresentation(candidate, helpers).promoted, false);
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.extractSemantics(candidate, helpers))), {
    contentKind: "post",
    relationshipType: "original",
    parentPermalink: null,
    engagement: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(candidate, helpers))), {
    url: "https://www.facebook.com/aku.example/posts/1234567890/",
    source: "post_anchor",
  });
});

test("Facebook adapter classifies the live account outage without parsing it as a feed", () => {
  const heading = { textContent: "Account Temporarily Unavailable." };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "main h1, main h2, main h3" ? [heading] : [],
  };
  const context = vm.createContext({
    document,
    window: { document, location: { hostname: "www.facebook.com", pathname: "/sorry.php", search: "?msg=account" } },
    URL,
    URLSearchParams,
  });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");

  assert.deepEqual(JSON.parse(JSON.stringify(context.AkuSourceAdapters.get("facebook").availability())), {
    state: "source_unavailable",
    code: "site_outage",
    message: "Facebook reports that the account is temporarily unavailable due to a site issue.",
    retryable: true,
  });
});

test("Facebook adapter recognizes the account outage shell without a semantic heading", () => {
  const document = {
    body: {
      innerText: "Account Temporarily Unavailable. Your account is currently unavailable due to a site issue. Please try again in a few minutes.",
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document,
    window: { document, location: { hostname: "www.facebook.com", pathname: "/", search: "" } },
    URL,
    URLSearchParams,
  });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");

  assert.equal(context.AkuSourceAdapters.get("facebook").availability()?.state, "source_unavailable");
});

test("Facebook adapter discovers the live Home Feed aria-posinset structure", () => {
  const candidate = facebookCandidate();
  candidate.parentElement = { closest: () => null };
  candidate.querySelectorAll = (selector) => {
    if (selector === '[role="button"], button') {
      return ["Like", "Leave a comment", "Send this to friends or post it on your profile."].map((label) => ({
        innerText: "",
        getAttribute: (name) => name === "aria-label" ? label : null,
      }));
    }
    return [];
  };
  const liveSelector = 'div[aria-posinset]';
  const document = {
    body: {},
    querySelector(value) { return value.includes(liveSelector) ? candidate : null; },
    querySelectorAll(value) { return value === liveSelector ? [candidate] : []; },
  };
  const context = vm.createContext({ document, window: { document, location: { hostname: "www.facebook.com", pathname: "/" } }, URL });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");
  const adapter = context.AkuSourceAdapters.get("facebook");
  const discovery = adapter.discoverCandidates({ uniqueElements: (items) => [...new Set(items)] });

  assert.equal(adapter.feedRootPresent(), true);
  assert.equal(discovery.strategy, liveSelector);
  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.readinessCandidates.length, 1);
});

test("Facebook adapter distinguishes structural feed cards from eligible posts", () => {
  const memoryCard = facebookCandidate();
  memoryCard.parentElement = { closest: () => null };
  memoryCard.querySelectorAll = (selector) => {
    if (selector === '[role="button"], button') {
      return ["Actions for this post", "Send", "Share"].map((label) => ({
        innerText: "",
        getAttribute: (name) => name === "aria-label" ? label : null,
      }));
    }
    return [];
  };
  const liveSelector = 'div[aria-posinset]';
  const document = {
    body: {},
    querySelector(value) { return value.includes(liveSelector) ? memoryCard : null; },
    querySelectorAll(value) { return value === liveSelector ? [memoryCard] : []; },
  };
  const context = vm.createContext({
    document,
    window: { document, location: { hostname: "www.facebook.com", pathname: "/" } },
    URL,
  });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");
  const discovery = context.AkuSourceAdapters.get("facebook").discoverCandidates({
    uniqueElements: (items) => [...new Set(items)],
  });

  assert.equal(discovery.readinessCandidates.length, 1);
  assert.equal(discovery.candidates.length, 0);
});

test("Facebook admits a stable media or text post without requiring two action buttons", () => {
  const permalink = {
    href: "https://www.facebook.com/photo/?fbid=987654321&set=pcb.1234567890",
    target: "_blank",
    innerText: "2h",
    getAttribute: () => null,
  };
  const author = {};
  const message = { innerText: "A stable post whose action row has not fully hydrated yet." };
  const candidate = {
    parentElement: { closest: () => null },
    closest: () => null,
    querySelector(selector) {
      if (selector === '[aria-label^="Actions for this reel by "]') return null;
      if (selector === '[aria-label^="Actions for this post by "]') return null;
      if (selector.includes('h2 a[role="link"]')) return author;
      if (selector.includes('[data-ad-preview="message"]')) return message;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="button"], button') {
        return [{
          innerText: "",
          getAttribute: (name) => name === "aria-label" ? "Like" : null,
        }];
      }
      if (selector === 'a[href]') return [permalink];
      return [];
    },
  };
  const liveSelector = 'div[aria-posinset]';
  const document = {
    body: {},
    querySelector: () => candidate,
    querySelectorAll(value) { return value === liveSelector ? [candidate] : []; },
  };
  const context = vm.createContext({
    document,
    window: { document, location: { hostname: "www.facebook.com", pathname: "/" } },
    URL,
  });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");

  const discovery = context.AkuSourceAdapters.get("facebook").discoverCandidates({
    uniqueElements: (items) => [...new Set(items)],
  });

  assert.equal(discovery.candidates.length, 1);
  assert.equal(discovery.selectorCounts["admitted:stable_identity_evidence"], 1);
});

test("Facebook adapter reads the current profile-link header and rendered relative time", () => {
  const contentRoot = {};
  const profileAnchor = {
    href: "https://www.facebook.com/aku.example",
    innerText: "",
    getAttribute: (name) => name === "aria-label" ? "Aku Example" : null,
    compareDocumentPosition: () => 4,
  };
  const fakeGlyph = glyph("q", 0, "absolute");
  const renderedGlyphs = [glyph("1", 10), glyph("2", 16), glyph("h", 24)];
  const timestampAnchor = { querySelectorAll: (selector) => selector === "span" ? [fakeGlyph, ...renderedGlyphs] : [] };
  const candidate = {
    innerText: "Aku Example\nA bounded Facebook post",
    querySelector(selector) {
      if (selector.includes('data-ad-preview="message"')) return contentRoot;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[role="link"][href]') return [profileAnchor];
      if (selector === 'a[target="_blank"]') return [timestampAnchor];
      return [];
    },
  };
  const document = { querySelector: () => ({}), querySelectorAll: () => [] };
  const window = {
    document,
    location: { hostname: "www.facebook.com", pathname: "/" },
    getComputedStyle: (element) => ({ position: element.position, display: "inline", visibility: "visible", opacity: "1" }),
  };
  const context = vm.createContext({ document, window, URL, getComputedStyle: window.getComputedStyle });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");
  const adapter = context.AkuSourceAdapters.get("facebook");
  const helpers = { compactText, normalizeHttpUrl };

  assert.equal(adapter.findAuthor(candidate, helpers), "Aku Example");
  assert.equal(adapter.extractPresentation(candidate, helpers).timestampText, "12h");
  assert.deepEqual(JSON.parse(JSON.stringify(
    adapter.estimateRelativeTimestamp("12h", "2026-07-18T23:39:32.000Z"),
  )), {
    publishedAt: "2026-07-18T11:00:00.000Z",
    amount: 12,
    unit: "h",
    precision: "hour",
    estimated: true,
  });
});

test("Facebook adapter trusts the explicit post action author and rejects presence labels", () => {
  const adapter = loadFacebookAdapter();
  const action = {
    getAttribute: (name) => name === "aria-label" ? "Actions for this post by Ibnu Mundzir" : null,
  };
  const presence = {
    href: "https://www.facebook.com/imundzir",
    innerText: "",
    getAttribute: (name) => name === "aria-label" ? "Online status indicator Active" : null,
  };
  const candidate = {
    querySelector(selector) {
      if (selector === '[aria-label^="Actions for this post by "]') return action;
      if (selector.includes('data-ad-preview="message"')) return {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[role="link"][href]') return [presence];
      return [];
    },
  };

  assert.equal(adapter.findAuthor(candidate, { compactText }), "Ibnu Mundzir");
});

test("Facebook feed adapter accepts an embedded Reel as native evidence without changing candidate scope", () => {
  const adapter = loadFacebookAdapter();
  assert.equal(adapter.platformIdFromCandidates([
    "https://www.facebook.com/reel/123456789/",
  ]), "facebook:post:123456789");
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(
    facebookIdentityCandidate(["https://www.facebook.com/reel/123456789/"]),
    { normalizeHttpUrl },
  ))), {
    url: "https://www.facebook.com/reel/123456789/",
    source: "embedded_video_anchor",
  });
  assert.match(adapter.mediaRendering.videoRootSelector, /reel/);
  const embeddedPoster = {
    matches: () => false,
    closest: (selector) => selector.includes('/reel/') ? {} : null,
  };
  const container = { querySelectorAll: () => [embeddedPoster] };
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.mediaAcquisition.detectExpectedKinds(container, {
    excludeRoot: null,
    uniqueElements: (items) => items,
  }))), ["video"]);
});

test("Facebook adapter canonicalizes post, video, and media-parent identity", () => {
  const adapter = loadFacebookAdapter();
  const direct = facebookIdentityCandidate([
    "https://www.facebook.com/aku.example/posts/pfbid02ABC123?comment_id=99&__cft__[0]=tracking",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(direct, { normalizeHttpUrl }))), {
    url: "https://www.facebook.com/aku.example/posts/pfbid02ABC123/",
    source: "post_anchor",
  });
  assert.equal(
    adapter.platformIdFromCandidates(["https://www.facebook.com/aku.example/posts/pfbid02ABC123/"]),
    "facebook:post:pfbid02ABC123",
  );
  const group = facebookIdentityCandidate([
    "https://www.facebook.com/groups/12345/posts/99887766/?comment_id=1",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(group, { normalizeHttpUrl }))), {
    url: "https://www.facebook.com/groups/12345/posts/99887766/",
    source: "post_anchor",
  });

  const video = facebookIdentityCandidate(["https://www.facebook.com/watch/?v=123456789&tracking=1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(video, { normalizeHttpUrl }))), {
    url: "https://www.facebook.com/watch/?v=123456789",
    source: "video_anchor",
  });

  const carousel = facebookIdentityCandidate([
    "https://www.facebook.com/photo/?fbid=10&set=pcb.99887766&tracking=1",
  ], "https://www.facebook.com/aku.example?tracking=1");
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.findPermalinkDetails(carousel, { normalizeHttpUrl }))), {
    url: "https://www.facebook.com/aku.example/posts/99887766/",
    source: "media_parent_id",
  });
});

function facebookCandidate() {
  const controls = ["Like", "Comment", "Share"].map((label) => ({
    innerText: label,
    getAttribute: (name) => name === "aria-label" ? label : null,
  }));
  const avatar = {
    src: "https://scontent.fcgk1-2.fna.fbcdn.net/avatar.jpg",
    currentSrc: "https://scontent.fcgk1-2.fna.fbcdn.net/avatar.jpg",
    getBoundingClientRect: () => ({ width: 40, height: 40 }),
  };
  const message = { innerText: "A bounded Facebook Home Feed post with useful source evidence.\nSee more" };
  const author = { innerText: "Aku Example" };
  const permalink = { href: "https://www.facebook.com/aku.example/posts/1234567890/" };
  return {
    innerText: "Aku Example\n2h\nA bounded Facebook Home Feed post with useful source evidence.\nLike\nComment\nShare",
    parentElement: null,
    querySelector(selector) {
      if (selector.includes('data-ad-preview="message"')) return message;
      if (selector === 'h2 a[role="link"]') return author;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="button"], button') return controls;
      if (selector === 'a[role="link"] img[src]') return [avatar];
      if (selector === 'a[href]') return [permalink];
      if (selector === '[aria-label], [role="button"]') return controls;
      return [];
    },
  };
}

function glyph(value, left, position = "relative") {
  return {
    textContent: value,
    position,
    getBoundingClientRect: () => ({ left, top: position === "absolute" ? 30 : 10, width: 5, height: 10 }),
  };
}

function facebookIdentityCandidate(hrefs, profileHref = null) {
  const anchors = hrefs.map((href) => ({ href }));
  const profile = profileHref ? [{ href: profileHref }] : [];
  return {
    querySelectorAll(selector) {
      if (selector === 'a[href]') return anchors;
      if (selector === 'a[role="link"][href]') return profile;
      return [];
    },
  };
}

function loadFacebookAdapter() {
  const document = { querySelector: () => ({}), querySelectorAll: () => [] };
  const context = vm.createContext({ document, window: { document, location: { hostname: "www.facebook.com", pathname: "/", search: "" } }, URL, URLSearchParams });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/facebook-adapter.js");
  return context.AkuSourceAdapters.get("facebook");
}

function compactText(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function normalizeHttpUrl(value) { return /^https?:\/\//i.test(value ?? "") ? value : null; }
function run(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context); }
