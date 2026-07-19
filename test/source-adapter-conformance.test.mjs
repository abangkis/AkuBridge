import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "source-adapter-conformance.json"), "utf8"));

for (const source of ["x", "linkedin"]) {
  test(`${source} adapter passes synthetic DOM conformance`, () => {
    const fixture = fixtures[source];
    const candidate = syntheticCandidate(source);
    if (source === "linkedin") {
      candidate.innerText += "\nwith Cassie Dell - Promoted - Partnership with LinkedIn";
    }
    const document = syntheticDocument(source, fixture.selector, candidate);
    const context = vm.createContext({ document, window: { document, location: {
      hostname: source === "x" ? "x.com" : "www.linkedin.com", pathname: source === "x" ? "/home" : "/feed/",
    } }, URL });
    context.globalThis = context;
    run(context, "source-adapter-runtime.js");
    run(context, `adapters/${source}-adapter.js`);
    const adapter = context.AkuSourceAdapters.get(source);
    const discovery = adapter.discoverCandidates({ compactText, uniqueElements: (items) => [...new Set(items)] });
    const semantics = adapter.extractSemantics(candidate, { compactText, normalizeHttpUrl });
    const avatarUrl = adapter.findAvatar(candidate, { compactText, normalizeHttpUrl });
    assert.equal(adapter.version, fixture.version);
    assert.equal(adapter.qualityProfile, "social-post-v2");
    assert.equal(adapter.evidenceProfile.contentFamily, "feed_post");
    assert.equal(discovery.candidates.length, 1);
    assert.equal(discovery.strategy, fixture.strategy);
    assert.equal(semantics.contentKind, fixture.contentKind);
    assert.equal(semantics.relationshipType, fixture.relationshipType);
    assert.equal(avatarUrl, fixture.avatarUrl);
    if (source === "x") {
      assert.equal(
        adapter.extractText(candidate, {
          compactText,
          structuredText: (value) => value?.innerText ?? "",
        }),
        fixture.text,
      );
      const quotedPost = adapter.extractQuotedPost(candidate, {
        compactText,
        normalizeHttpUrl,
        findMedia: () => fixture.quotedPost.media,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(quotedPost)), fixture.quotedPost);
    }
    if (source === "linkedin") {
      assert.equal(adapter.qualitySelectors.avatar.includes('a[href*="/in/"] img'), true);
      assert.match(adapter.qualitySelectors.avatar, /feed-actor-image/);
      assert.equal(
        adapter.extractText(candidate, {
          compactText,
          structuredText: (value) => value?.innerText ?? "",
        }),
        "A complete LinkedIn post body.\n\nSecond paragraph.",
      );
      const presentation = adapter.extractPresentation(candidate, { compactText, normalizeHttpUrl });
      assert.equal(presentation.socialContext, "Reza Lesmana likes this");
      assert.equal(presentation.headline, "Cybersecurity Leader | Executive");
      assert.equal(presentation.attributionText, "with Cassie Dell - Promoted - Partnership with LinkedIn");
      assert.equal(presentation.connectionDegree, "2nd");
      assert.equal(presentation.timestampText, "12h · Edited");
      assert.equal(presentation.timestampAvailability, "relative_text");
      assert.equal(presentation.edited, true);
      assert.equal(presentation.promoted, true);
      const commentedCandidate = {
        ...candidate,
        innerText: candidate.innerText.replace("Reza Lesmana likes this", "Mohamad Ramzy commented"),
      };
      const commentedPresentation = adapter.extractPresentation(commentedCandidate, { compactText, normalizeHttpUrl });
      assert.equal(commentedPresentation.socialContext, "Mohamad Ramzy commented");
      const attachments = adapter.extractAttachments(candidate, {
        compactText,
        normalizeHttpUrl,
        normalizeHttpsUrl,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(attachments[0])), {
        kind: "job",
        title: "Management Intern",
        subtitle: "Kargo Technologies",
        detail: "Singapore (On-site)",
        actionLabel: "View job",
        footnote: "10 school alumni work here",
        url: "https://www.linkedin.com/jobs/view/4439405587/",
        imageUrl: "https://media.licdn.com/dms/image/job-logo",
        verified: true,
      });
      const externalCard = syntheticExternalCard();
      const externalCandidate = {
        ...candidate,
        querySelector(selector) {
          if (selector === '[data-testid="expandable-text-box"]') return linkedinTextForExternalCard();
          return candidate.querySelector(selector);
        },
        querySelectorAll(selector) {
          if (selector === 'a[href]') return [externalCard];
          return candidate.querySelectorAll(selector);
        },
      };
      assert.deepEqual(
        JSON.parse(JSON.stringify(adapter.extractAttachments(externalCandidate, {
          compactText,
          normalizeHttpUrl,
          normalizeHttpsUrl,
        }))),
        [{
          kind: "link_preview",
          title: "Head of IT (ERP Developer)",
          subtitle: "Robert Walters",
          detail: "",
          actionLabel: "Open link",
          url: "https://www.aplitrak.com/job/head-of-it",
          domain: "aplitrak.com",
          imageUrl: "https://media.licdn.com/dms/image/link-card-logo",
        }],
      );
      const insecureCard = syntheticExternalCard();
      insecureCard.href = "https://www.linkedin.com/safety/go?url=http%3A%2F%2Finsecure.example%2Fjob";
      const insecureCandidate = {
        ...externalCandidate,
        querySelectorAll(selector) {
          if (selector === 'a[href]') return [insecureCard];
          return externalCandidate.querySelectorAll(selector);
        },
      };
      assert.deepEqual(
        JSON.parse(JSON.stringify(adapter.extractAttachments(insecureCandidate, {
          compactText,
          normalizeHttpUrl,
          normalizeHttpsUrl,
        }))),
        [],
      );
      assert.deepEqual(JSON.parse(JSON.stringify(semantics.engagement)), { like: "53", repost: "1" });
      const collaborativeAvatar = syntheticImage(
        "https://media.licdn.com/dms/image/linkedin-collaborative-avatar",
        "",
        48,
      );
      const collaborativeCandidate = {
        ...candidate,
        querySelectorAll(selector) {
          if (selector === 'button[aria-label]') return [];
          if (selector.includes('a[href*="/in/"] img')) return [socialAvatarForTest(), collaborativeAvatar];
          return [];
        },
      };
      assert.equal(
        adapter.findAvatar(collaborativeCandidate, {
          compactText,
          normalizeHttpUrl,
        }),
        "https://media.licdn.com/dms/image/linkedin-collaborative-avatar",
      );
      const companyAvatar = syntheticImage(
        "https://media.licdn.com/dms/image/company-logo",
        "Bank Mega",
        48,
      );
      const companyCandidate = {
        ...candidate,
        querySelectorAll(selector) {
          if (selector.includes('a[href*="/company/"] img')) return [companyAvatar];
          if (selector === 'button[aria-label]') return [{
            getAttribute: () => "Open control menu for post by Bank Mega",
          }];
          return [];
        },
      };
      assert.equal(
        adapter.findAvatar(companyCandidate, { compactText, normalizeHttpUrl }),
        "https://media.licdn.com/dms/image/company-logo",
      );
    }
  });
}

test("X adapter uses response-backed avatar evidence when the DOM avatar is not hydrated", () => {
  const document = syntheticDocument("x", fixtures.x.selector, syntheticCandidate("x"));
  const context = vm.createContext({
    document,
    window: { document, location: { hostname: "x.com", pathname: "/home" } },
    URL,
    AkuXMediaEvidenceRuntime: {
      lookupAvatarContainer: () => "https://pbs.twimg.com/profile_images/12345/fallback_normal.jpg",
    },
  });
  context.globalThis = context;
  run(context, "source-adapter-runtime.js");
  run(context, "adapters/x-adapter.js");
  const adapter = context.AkuSourceAdapters.get("x");
  const container = { querySelector: () => null };

  assert.equal(
    adapter.findAvatar(container, { normalizeHttpUrl }),
    "https://pbs.twimg.com/profile_images/12345/fallback_normal.jpg",
  );
});

function syntheticDocument(source, selector, candidate) {
  return {
    body: {},
    querySelector(value) { return value === "main" ? { querySelectorAll: () => [] } : null; },
    querySelectorAll(value) { return value === selector ? [candidate] : []; },
  };
}

function syntheticCandidate(source) {
  const attributes = source === "linkedin" ? { "data-view-name": "feed-full-update" } : {};
  const mainAvatar = source === "x"
    ? syntheticImage("https://pbs.twimg.com/profile_images/x-avatar.jpg", "", 40, "blob:https://x.com/avatar-placeholder")
    : syntheticImage("https://media.licdn.com/dms/image/linkedin-avatar", "View Dr. Semi Yulianto’s profile", 48);
  const socialAvatar = syntheticImage("https://media.licdn.com/dms/image/context-avatar", "", 24);
  const menuButton = { getAttribute: (name) => name === "aria-label" ? "Open control menu for post by Dr. Semi Yulianto" : null };
  const reactionButton = syntheticActionButton("Reaction button state: no reaction", "53");
  const repostButton = syntheticActionButton("Repost", "1");
  const linkedinText = { innerText: "A complete LinkedIn post body.\n\nSecond paragraph." };
  const jobLogo = syntheticImage("https://media.licdn.com/dms/image/job-logo", "", 48);
  const linkedinAttachment = {
    href: "https://www.linkedin.com/jobs/view/4439405587/",
    innerText: "Management Intern (Verified job)\nManagement Intern\nKargo Technologies\nSingapore (On-site)\nView job\n10 school alumni work here",
    querySelectorAll: (selector) => selector === "img" ? [jobLogo] : [],
  };
  const quotedAvatar = syntheticImage("https://pbs.twimg.com/profile_images/ian-avatar.jpg", "", 32);
  const quotedTime = {
    getAttribute: (name) => name === "datetime" ? "2026-07-13T00:00:00.000Z" : null,
    closest: () => null,
  };
  const quotedText = {
    innerText: "A quoted post body preserved as nested source evidence.",
    querySelectorAll: () => [],
    closest: (selector) => selector === '[role="link"]' ? quotedContainer : null,
  };
  const quotedContainer = {
    querySelector(selector) {
      if (selector === '[data-testid="tweetText"]') return quotedText;
      if (selector === '[data-testid="User-Name"]') return { innerText: "Ian Bremmer @ianbremmer · 18h" };
      if (selector === '[data-testid^="UserAvatar-Container-"] img') return quotedAvatar;
      if (selector === "time") return quotedTime;
      return null;
    },
    querySelectorAll: () => [],
  };
  const mainText = {
    innerText: "Author quoted a technical update.\n\n1 First item\n2 Second item",
    querySelectorAll: () => [],
  };
  return {
    innerText: source === "x"
      ? mainText.innerText
      : "Feed post\nReza Lesmana likes this\nDr. Semi Yulianto\n• 2nd\nCybersecurity Leader | Executive\n12h · Edited ·\nFollow\nA complete LinkedIn post body.",
    parentElement: null,
    matches(selector) { return source === "linkedin" && selector.includes("feed-full-update"); },
    contains() { return false; },
    getAttribute(name) { return attributes[name] ?? null; },
    querySelector(selector) {
      if (source === "x" && selector === '[data-testid="tweetText"]') return mainText;
      if (source === "x" && selector.includes("quoteTweet")) return null;
      if (source === "x" && selector.includes("UserAvatar-Container")) return mainAvatar;
      if (source === "linkedin" && selector.includes("document")) return {};
      if (source === "linkedin" && selector === '[data-testid="expandable-text-box"]') return linkedinText;
      if (source === "linkedin" && selector === 'a[href*="/jobs/view/"]') return linkedinAttachment;
      return null;
    },
    querySelectorAll(selector) {
      if (source === "x" && selector === '[data-testid="tweetText"]') return [mainText, quotedText];
      if (source === "x" && selector === 'a[href*="/status/"]') return [];
      if (source === "linkedin" && selector === "button[aria-label]") return [menuButton, reactionButton, repostButton];
      if (source === "linkedin" && selector === 'button,[role="button"]') return [menuButton, reactionButton, repostButton];
      if (source === "linkedin" && selector === 'a[href] img') return [socialAvatar, mainAvatar];
      if (source === "linkedin" && selector.includes('a[href*="/in/"] img')) return [socialAvatar, mainAvatar];
      if (source === "linkedin" && selector === 'a[href]') return [linkedinAttachment];
      return [];
    },
  };
}

function syntheticActionButton(ariaLabel, innerText) {
  return {
    innerText,
    getAttribute(name) {
      if (name === "aria-label") return ariaLabel;
      return null;
    },
  };
}

function syntheticImage(src, alt, size, currentSrc = src) {
  return {
    src,
    currentSrc,
    srcset: "",
    alt,
    getAttribute(name) {
      if (name === "src") return src;
      if (name === "srcset") return "";
      return null;
    },
    getBoundingClientRect: () => ({ width: size, height: size }),
    closest: () => ({ pathname: "/in/fixture/" }),
  };
}

function socialAvatarForTest() {
  return syntheticImage("https://media.licdn.com/dms/image/context-avatar", "", 24);
}

function linkedinTextForExternalCard() {
  return { innerText: "Hi all, I am currently recruiting for this position.", contains: () => false };
}

function syntheticExternalCard() {
  const image = syntheticImage("https://media.licdn.com/dms/image/link-card-logo", "Robert Walters", 72);
  return {
    href: "https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwww.aplitrak.com%2Fjob%2Fhead-of-it",
    innerText: "Head of IT (ERP Developer)\nRobert Walters\naplitrak.com",
    getBoundingClientRect: () => ({ width: 440, height: 120 }),
    querySelectorAll: (selector) => selector === "img" ? [image] : [],
  };
}

function compactText(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function normalizeHttpUrl(value) {
  return /^https?:\/\//i.test(value ?? "") ? value : null;
}
function normalizeHttpsUrl(value) {
  return /^https:\/\//i.test(value ?? "") ? value : null;
}
function run(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context); }
