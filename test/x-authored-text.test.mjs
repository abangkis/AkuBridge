import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({
  URL,
  window: { location: { hostname: "x.com", pathname: "/home", href: "https://x.com/home" } },
});
context.globalThis = context;
for (const source of ["capture-primitives.js", "source-adapter-runtime.js", "adapters/x-adapter.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, source), "utf8"), context, { filename: source });
}

const adapter = context.AkuSourceAdapters.get("x");
const text = (value) => value?.innerText ?? "";
const helpers = {
  compactText: (value) => String(value ?? "").replace(/\s+/g, " ").trim(),
  structuredText: text,
  normalizeHttpUrl: (value) => value || null,
};

function node(testId, innerText = "", children = []) {
  const element = {
    nodeType: 1,
    tagName: "DIV",
    innerText,
    textContent: innerText,
    childNodes: [{ nodeType: 3, nodeValue: innerText }],
    children,
    getAttribute(name) {
      if (name === "data-testid") return testId;
      return null;
    },
    matches(selector) {
      return (testId === "tweetText" && selector.includes('[data-testid="tweetText"]')) ||
        (testId === "twitterArticleReadView" && selector.includes('[data-testid="twitterArticleReadView"]'));
    },
    contains(target) {
      return descendants(this).includes(target);
    },
    querySelector(selector) {
      return descendants(this).find((child) => matchesTestId(selector, child.getAttribute("data-testid"))) ?? null;
    },
    querySelectorAll(selector) {
      return descendants(this).filter((child) => matchesTestId(selector, child.getAttribute("data-testid")));
    },
    closest() { return null; },
  };
  return element;
}

function descendants(parent) {
  return parent.children.flatMap((child) => [child, ...descendants(child)]);
}

function matchesTestId(selector, testId) {
  return Boolean(testId && selector.includes(`[data-testid="${testId}"]`));
}

test("X authored text stays empty for image-only posts with visible author and engagement UI", () => {
  const candidate = node("tweet", "Owner\n12 likes\nReply\n1 repost", [
    node("tweetPhoto", ""),
  ]);
  assert.equal(adapter.extractText(candidate, helpers), "");
});

test("X image captions preserve authored words and numbers without nearby UI text", () => {
  const caption = "My 2026 build took 42 iterations. Like and Reply are part of the story.";
  const candidate = node("tweet", `Owner\n${caption}\n12 likes\nReply`, [
    node("tweetText", caption),
    node("tweetPhoto", ""),
  ]);
  assert.equal(adapter.extractText(candidate, helpers), caption);
});

test("a media-only quoted post contributes no primary authored text", () => {
  const quote = node("quoteTweet", "Quoted author\n5 likes\nReply", [node("tweetPhoto", "")]);
  const candidate = node("tweet", "Owner\n8 likes\nReply", [quote]);
  assert.equal(adapter.extractText(candidate, helpers), "");

  const quotedPost = adapter.extractQuotedPost(candidate, {
    ...helpers,
    findMedia: (root) => root === quote ? [{ kind: "image", url: "https://pbs.twimg.com/media/photo.jpg" }] : [],
  });
  assert.equal(quotedPost.text, "");
  assert.equal(quotedPost.media.length, 1);
});

test("own caption is kept separate from quoted text and media", () => {
  const ownCaption = "My photo has 3 blue doors.";
  const quotedText = "The quoted post says 9 is the answer.";
  const quote = node("quoteTweet", `Quoted author\n${quotedText}\n5 likes`, [node("tweetText", quotedText)]);
  const candidate = node("tweet", `Owner\n${ownCaption}\n8 likes`, [node("tweetText", ownCaption), quote]);

  assert.equal(adapter.extractText(candidate, helpers), ownCaption);
  assert.equal(adapter.extractQuotedPost(candidate, { ...helpers, findMedia: () => [] }).text, quotedText);
});

test("X adapter accepts tweet text and article read-view roots directly", () => {
  const tweetText = node("tweetText", "Direct tweet root 123.");
  const article = node("twitterArticleReadView", "Direct article root 456.");

  assert.equal(adapter.extractText(tweetText, helpers), "Direct tweet root 123.");
  assert.equal(adapter.extractText(article, helpers), "Direct article root 456.");
});

test("quoted text is not promoted into an otherwise textless parent", () => {
  const quote = node("quoteTweet", "Quoted author", [node("tweetText", "Quoted caption")]);
  const candidate = node("tweet", "Owner\nImage\n81\n27\n811\n37K", [node("tweetPhoto"), quote]);
  assert.equal(adapter.extractText(candidate, helpers), "");
  assert.equal(adapter.extractQuotedPost(candidate, { ...helpers, findMedia: () => [] }).text, "Quoted caption");
});

test("article bodies and compact-text callers preserve authored content", () => {
  const article = node("twitterArticleReadView", "An authored article body.");
  assert.equal(adapter.extractText(node("tweet", "Owner\nArticle\n81", [article]), helpers), article.innerText);
  const compactHelpers = { compactText: helpers.compactText };
  assert.equal(adapter.extractText(node("tweetText", "Caption 81\n27"), compactHelpers), "Caption 81 27");
  assert.equal(adapter.extractText(node("tweet", "Owner\nImage\n81"), compactHelpers), "");
});

test("a sole quoted text root in a role-link quote stays nested without an explicit quote test ID", () => {
  const quotedText = node("tweetText", "Quoted caption");
  const quote = node(null, "Quoted author", [quotedText]);
  quotedText.closest = selector => selector === '[role="link"]' ? quote : null;
  const candidate = node("tweet", "Owner\nImage\n81", [quote]);
  assert.equal(adapter.findQuotedRoot(candidate), quote);
  assert.equal(adapter.extractText(candidate, helpers), "");
  assert.equal(adapter.extractQuotedPost(candidate, { ...helpers, findMedia: () => [] }).text, "Quoted caption");

  const ownText = node("tweetText", "Own caption after quoted DOM");
  candidate.children.push(ownText);
  assert.equal(adapter.extractText(candidate, helpers), ownText.innerText);
});

test("a role-link outside the post cannot claim its own authored text as a quote", () => {
  const ownText = node("tweetText", "Own caption");
  const candidate = node("tweet", "Owner\nOwn caption", [ownText]);
  const ancestor = node(null, "Outer navigation", [candidate]);
  ownText.closest = selector => selector === '[role="link"]' ? ancestor : null;
  assert.equal(adapter.findQuotedRoot(candidate), null);
  assert.equal(adapter.extractText(candidate, helpers), ownText.innerText);
});
