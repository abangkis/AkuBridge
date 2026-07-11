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
    assert.equal(adapter.version, fixture.version);
    assert.equal(discovery.candidates.length, 1);
    assert.equal(discovery.strategy, fixture.strategy);
    assert.equal(semantics.contentKind, fixture.contentKind);
    assert.equal(semantics.relationshipType, fixture.relationshipType);
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
  return {
    innerText: source === "x" ? "Author quoted a technical update" : "Author reposted this technical document update",
    parentElement: null,
    matches(selector) { return source === "linkedin" && selector.includes("feed-full-update"); },
    contains() { return false; },
    getAttribute(name) { return attributes[name] ?? null; },
    querySelector(selector) {
      if (source === "x" && selector.includes("quoteTweet")) return {};
      if (source === "linkedin" && selector.includes("document")) return {};
      return null;
    },
    querySelectorAll() { return []; },
  };
}

function compactText(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function run(context, file) { vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context); }
