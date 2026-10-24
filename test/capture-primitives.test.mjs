import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "capture-primitives.js"), "utf8");

function primitives() {
  const context = vm.createContext({ URL, setTimeout });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: "capture-primitives.js" });
  return context.AkuCapturePrimitives;
}

test("capture primitives are frozen and structured text keeps paragraphs and emoji alt text", () => {
  const api = primitives();
  const text = {
    nodeType: 1,
    tagName: "DIV",
    childNodes: [
      { nodeType: 1, tagName: "P", childNodes: [{ nodeType: 3, nodeValue: "First " }, { nodeType: 1, tagName: "IMG", getAttribute: () => "🌻" }] },
      { nodeType: 1, tagName: "P", childNodes: [{ nodeType: 3, nodeValue: "Second" }] },
    ],
  };

  assert.equal(Object.isFrozen(api), true);
  assert.equal(api.structuredText(text), "First 🌻\nSecond");
});

function challengeText(value) {
  return { nodeType: 3, nodeValue: value };
}

function challengeElement(tagName, attributes = {}, children = []) {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    hidden: false,
    getAttribute(name) { return attributes[name] ?? null; },
    matches(selector) {
      if (selector === 'article[data-testid="tweet"]') {
        return tagName.toLowerCase() === "article" && attributes["data-testid"] === "tweet";
      }
      if (selector === '[data-testid="tweetText"]') return attributes["data-testid"] === "tweetText";
      if (selector === '[data-testid="quoteTweet"]') return attributes["data-testid"] === "quoteTweet";
      return false;
    },
  };
}

function challengeDocument(children = [], challengeSelectors = []) {
  return {
    body: challengeElement("body", {}, children),
    querySelector(selector) { return challengeSelectors.includes(selector) ? {} : null; },
  };
}

test("X access challenges recognize the exact Cloudflare and X human verification screens", () => {
  const detect = primitives().detectXAccessChallenge;
  const location = { hostname: "x.com" };
  const cloudflare = detect(challengeDocument([
    challengeElement("main", {}, [challengeText("Performing security verification. Verify you are human.")]),
  ]), location);
  assert.equal(cloudflare.code, "challenge_required");
  assert.equal(cloudflare.category, "cloudflare");
  assert.match(cloudflare.message, /source browser/);
  assert.doesNotMatch(cloudflare.message, /Performing security verification/);

  const xChallenge = detect(challengeDocument([
    challengeElement("main", {}, [challengeText("Let’s confirm you are a human. Open the X app on your phone to continue.")]),
  ]), location);
  assert.equal(xChallenge.code, "challenge_required");
  assert.equal(xChallenge.category, "x_human_verification");
  assert.match(xChallenge.message, /source browser/);
});

test("X access challenge detection ignores quoted posts, login screens, and other hosts", () => {
  const detect = primitives().detectXAccessChallenge;
  const postText = "Let’s confirm you are a human. Open the X app on your phone to continue.";
  const quotedPost = challengeElement("article", { "data-testid": "tweet" }, [
    challengeElement("div", { "data-testid": "quoteTweet" }, [challengeText(postText)]),
  ]);
  const loginPage = challengeDocument([
    challengeElement("main", {}, [challengeText("Sign in to X. Email or username. Password.")]),
  ]);
  assert.equal(detect(challengeDocument([quotedPost]), { hostname: "x.com" }), null);
  assert.equal(detect(loginPage, { hostname: "x.com" }), null);
  assert.equal(detect(challengeDocument([
    challengeElement("main", {}, [challengeText("Performing security verification. Verify you are human.")]),
  ]), { hostname: "example.com" }), null);
});

test("X Cloudflare challenge DOM marker is detected without reading its page text", () => {
  const challenge = primitives().detectXAccessChallenge(
    challengeDocument([], ["#challenge-running"]),
    { hostname: "x.com" },
  );
  assert.equal(challenge.code, "challenge_required");
  assert.equal(challenge.category, "cloudflare");
});

test("legacy X captcha and Arkose iframe markers remain access challenges", () => {
  const detect = primitives().detectXAccessChallenge;
  for (const selector of ['iframe[src*="captcha"]', 'iframe[src*="arkoselabs"]']) {
    const challenge = detect(challengeDocument([], [selector]), { hostname: "x.com" });
    assert.equal(challenge.code, "challenge_required", selector);
    assert.equal(challenge.category, "x_human_verification", selector);
  }
});

test("X canonical permalink validation requires the exact secure host and no explicit port", () => {
  const canonicalize = primitives().canonicalizeXPermalink;

  assert.equal(canonicalize("https://x.com/author/status/123/photo/1?ref=feed#detail"), "https://x.com/author/status/123");
  for (const value of [
    "http://x.com/author/status/123",
    "https://x.com:443/author/status/123",
    "https://user@x.com/author/status/123",
    "https://www.x.com/author/status/123",
    "https://x.com.evil.test/author/status/123",
    "https://x.com/home",
    "/author/status/123",
  ]) assert.equal(canonicalize(value), null, value);
});

test("expansion labels accept More, Show more, See more, Less, and leading ellipses", () => {
  const label = primitives().expansionLabel;

  for (const value of ["More", "Show more", "See more", "… More", "... See more"]) {
    assert.equal(label(value, "more"), true, value);
  }
  for (const value of ["Less", "Show less", "See less", "… Less"]) {
    assert.equal(label(value, "less"), true, value);
  }
  assert.equal(label("More replies", "more"), false);
});

test("expandContent ignores quote controls, follows replaced content roots, and restore uses the latest Less control", async () => {
  const api = primitives();
  const quoteRoot = { contains: (element) => element?.insideQuote === true };
  let route = "https://x.com/author/status/1";
  let root = { nodeType: 1, tagName: "DIV", childNodes: [], innerText: "Short" };
  const quoteButton = { innerText: "Show more", insideQuote: true, click() { throw new Error("quote clicked"); } };
  const firstMore = { innerText: "… See more", click() {
    root = { nodeType: 1, tagName: "DIV", childNodes: [], innerText: "Short full text 🌱" };
    activeButton = { innerText: "Less", click() {
      root = { nodeType: "replacement", innerText: "Short" };
      activeButton = { innerText: "Show more", click() {} };
    } };
  } };
  let activeButton = firstMore;
  const container = {
    querySelectorAll(selector) {
      return selector === ".root" ? [root] : selector === ".button" ? [quoteButton, activeButton] : [];
    },
  };
  const adapter = {
    contentRootSelector: ".root",
    findQuotedRoot: () => quoteRoot,
    contentExpansion: { buttonSelector: ".button", restorable: true, attempts: 2, intervalMs: 0 },
  };
  const expansion = await api.expandContent({
    container,
    adapter,
    readText: (node) => api.structuredText(node),
    route: () => route,
    wait: async () => {},
  });

  assert.equal(expansion.state, "expanded");
  assert.equal(expansion.expanded, true);
  assert.equal(expansion.before, "Short");
  assert.equal(expansion.contentRoot, root);
  assert.equal(expansion.button, activeButton);
  assert.equal(await api.restoreContent(expansion, { route: () => route, wait: async () => {} }), "expanded_restored");
  assert.equal(expansion.state, "expanded_restored");
});

test("expandContent aborts safely when the page route changes after clicking", async () => {
  const api = primitives();
  let route = "https://x.com/author/status/1";
  const root = { nodeType: 1, tagName: "DIV", childNodes: [], innerText: "Short" };
  const button = { innerText: "More", click() { route = "https://x.com/author/status/2"; } };
  const container = {
    querySelectorAll(selector) { return selector === ".root" ? [root] : selector === ".button" ? [button] : []; },
  };
  const expansion = await api.expandContent({
    container,
    adapter: { contentRootSelector: ".root", contentExpansion: { buttonSelector: ".button", restorable: false } },
    route: () => route,
    wait: async () => {},
  });

  assert.equal(expansion.state, "route_changed");
  assert.equal(expansion.expanded, false);
});

test("expandContent reports absence of a collapse control without claiming complete text", async () => {
  const api = primitives();
  const root = { nodeType: 1, tagName: "DIV", childNodes: [], innerText: "Visible paragraph" };
  const container = {
    querySelectorAll(selector) { return selector === ".root" ? [root] : []; },
  };
  const expansion = await api.expandContent({
    container,
    adapter: { contentRootSelector: ".root", contentExpansion: { buttonSelector: ".button" } },
    wait: async () => {},
  });

  assert.equal(expansion.state, "no_collapse_observed");
  assert.equal(api.textCompleteness({ expansionState: expansion.state }), "no_collapse_observed");
});

test("text completeness stays additive and text replacement requires exact identity and longer Unicode text", () => {
  const api = primitives();

  assert.equal(api.textCompleteness({ expansionState: "no_collapse_observed" }), "no_collapse_observed");
  assert.equal(api.textCompleteness({ textStatus: "visible_text_no_collapse_control" }), "no_collapse_observed");
  assert.equal(api.textCompleteness({ textStatus: "expanded" }), "expanded");
  assert.equal(api.textCompleteness({ textStatus: "permalink_text_verified" }), "recovery_verified");
  assert.equal(api.textCompleteness({ textStatus: "visible_text_may_be_collapsed" }), "partial");
  assert.equal(api.textCompleteness({ textStatus: "permalink_text_verified", truncated: true }), "truncated");
  assert.equal(api.textCompleteness({}), "unknown");
  assert.equal(api.evaluateTextReplacement({ originalText: "🌱", recoveredText: "🌱🌼", identityMatches: true, resolved: true }), true);
  assert.equal(api.evaluateTextReplacement({ originalText: "🌱", recoveredText: "🌱🌼", identityMatches: false, resolved: true }), false);
  assert.equal(api.evaluateTextReplacement({ originalText: "🌱🌼", recoveredText: "🌱", identityMatches: true, resolved: true }), false);
  assert.equal(api.evaluateTextReplacement({ originalText: "a", recoveredText: "a longer", identityMatches: true, resolved: false }), false);
});

test("primary and quote identity helpers report ambiguity and conflicts without choosing an identity", () => {
  const api = primitives();

  assert.deepEqual(JSON.parse(JSON.stringify(api.resolvePrimaryIdentity({ permalinks: [] }))), {
    status: "missing", permalink: null, candidates: [], expectedPermalink: null,
  });
  assert.equal(api.resolvePrimaryIdentity({
    permalinks: ["https://x.com/a/status/1", "https://x.com/b/status/2"],
  }).status, "ambiguous");
  assert.equal(api.resolvePrimaryIdentity({
    permalinks: ["https://x.com/a/status/1"], expectedPermalink: "https://x.com/b/status/2",
  }).status, "conflicting");
  assert.equal(api.resolvePrimaryIdentity({ permalinks: ["https://x.com/a/status/1"] }).permalink, "https://x.com/a/status/1");

  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["1"] }).status, "conflicting_identity");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", domPermalink: "https://x.com/q/status/2", explicitQuoteIds: ["3"] }).status, "conflicting_identity");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["2", "3"] }).status, "conflicting_identity");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", domPermalink: "https://x.com/q/status/2" }).permalink, "https://x.com/q/status/2");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["2"], bounded: true }).status, "bounded_unresolved");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["2"] }).source, "main_structured_quote_relation");
  assert.equal(api.resolveQuoteIdentity({ primaryId: Number.MAX_SAFE_INTEGER + 1, explicitQuoteIds: ["2"] }).status, "identified");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["2", "3"] }).conflictReason, "multiple_explicit_ids");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: ["1"] }).conflictReason, "primary_self_reference");
  assert.equal(api.resolveQuoteIdentity({ primaryId: "1", explicitQuoteIds: [{ toString: () => "2" }] }).status, "unknown");
});
