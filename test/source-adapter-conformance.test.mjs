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
    const semantics = adapter.extractSemantics(candidate, { compactText, normalizeHttpUrl: (value) => value || null });
    const avatarUrl = adapter.findAvatar(candidate, { compactText, normalizeHttpUrl: (value) => value || null });
    assert.equal(adapter.version, fixture.version);
    assert.equal(discovery.candidates.length, 1);
    assert.equal(discovery.strategy, fixture.strategy);
    assert.equal(semantics.contentKind, fixture.contentKind);
    assert.equal(semantics.relationshipType, fixture.relationshipType);
    assert.equal(avatarUrl, fixture.avatarUrl);
    if (source === "linkedin") {
      const presentation = adapter.extractPresentation(candidate, { compactText, normalizeHttpUrl: (value) => value || null });
      assert.equal(presentation.socialContext, "Reza Lesmana likes this");
      assert.equal(presentation.headline, "Cybersecurity Leader | Executive");
      assert.equal(presentation.attributionText, "with Cassie Dell - Promoted - Partnership with LinkedIn");
      assert.equal(presentation.connectionDegree, "2nd");
      assert.equal(presentation.timestampText, "12h · Edited ·");
      assert.equal(presentation.edited, true);
      assert.equal(presentation.promoted, true);
      const collaborativeAvatar = syntheticImage(
        "https://media.licdn.com/dms/image/linkedin-collaborative-avatar",
        "",
        32,
      );
      const collaborativeCandidate = {
        ...candidate,
        querySelectorAll(selector) {
          if (selector === 'button[aria-label]') return [];
          if (selector === 'a[href] img') return [socialAvatarForTest(), collaborativeAvatar];
          return [];
        },
      };
      assert.equal(
        adapter.findAvatar(collaborativeCandidate, {
          compactText,
          normalizeHttpUrl: (value) => value || null,
        }),
        "https://media.licdn.com/dms/image/linkedin-collaborative-avatar",
      );
    }
  });
}

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
    ? syntheticImage("https://pbs.twimg.com/profile_images/x-avatar.jpg", "", 40)
    : syntheticImage("https://media.licdn.com/dms/image/linkedin-avatar", "View Dr. Semi Yulianto’s profile", 48);
  const socialAvatar = syntheticImage("https://media.licdn.com/dms/image/context-avatar", "", 24);
  const menuButton = { getAttribute: (name) => name === "aria-label" ? "Open control menu for post by Dr. Semi Yulianto" : null };
  return {
    innerText: source === "x"
      ? "Author quoted a technical update"
      : "Feed post\nReza Lesmana likes this\nDr. Semi Yulianto\n• 2nd\nCybersecurity Leader | Executive\n12h · Edited ·\nFollow\nA complete LinkedIn post body.",
    parentElement: null,
    matches(selector) { return source === "linkedin" && selector.includes("feed-full-update"); },
    contains() { return false; },
    getAttribute(name) { return attributes[name] ?? null; },
    querySelector(selector) {
      if (source === "x" && selector.includes("quoteTweet")) return {};
      if (source === "x" && selector.includes("UserAvatar-Container")) return mainAvatar;
      if (source === "linkedin" && selector.includes("document")) return {};
      return null;
    },
    querySelectorAll(selector) {
      if (source === "linkedin" && selector === "button[aria-label]") return [menuButton];
      if (source === "linkedin" && selector === 'a[href] img') return [socialAvatar, mainAvatar];
      if (source === "linkedin" && selector === 'a[href*="/in/"] img') return [socialAvatar, mainAvatar];
      return [];
    },
  };
}

function syntheticImage(src, alt, size) {
  return {
    src,
    currentSrc: src,
    alt,
    getBoundingClientRect: () => ({ width: size, height: size }),
    closest: () => ({ pathname: "/in/fixture/" }),
  };
}

function socialAvatarForTest() {
  return syntheticImage("https://media.licdn.com/dms/image/context-avatar", "", 24);
}

function compactText(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function run(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context); }
