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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("source catalog exposes Facebook without changing the X media capability", () => {
  assert.deepEqual(sourceAdapterVersions(), {
    x: "x-dom-v19",
    linkedin: "linkedin-dom-v15",
    facebook: "facebook-dom-v2",
  });
  assert.equal(sourceForUrl("https://www.facebook.com/"), "facebook");
  assert.equal(isCanonicalFeed("https://www.facebook.com/", "facebook"), true);
  assert.equal(isNativePostUrl("https://www.facebook.com/example/posts/123456/", "facebook"), true);
  assert.equal(isNativePostUrl("https://evil.example/posts/123456/", "facebook"), false);
});

test("static MV3 manifest stays synchronized with the generic source catalog", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const contentMatches = new Set(manifest.content_scripts.flatMap((entry) => entry.matches ?? []));
  const contentFiles = new Set(manifest.content_scripts.flatMap((entry) => entry.js ?? []));
  for (const pattern of sourceMatchPatterns()) {
    assert.equal(contentMatches.has(pattern), true, `manifest is missing ${pattern}`);
  }
  for (const file of sourceRuntimeScripts()) {
    assert.equal(contentFiles.has(file), true, `manifest is missing ${file}`);
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

  assert.equal(adapter.version, "facebook-dom-v2");
  assert.equal(discovery.candidates.length, 1);
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
    source: "direct_anchor",
  });
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

function compactText(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function normalizeHttpUrl(value) { return /^https?:\/\//i.test(value ?? "") ? value : null; }
function run(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context); }
