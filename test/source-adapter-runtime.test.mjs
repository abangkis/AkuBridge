import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("source adapters register independently behind one contract", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  runScript(context, path.join("adapters", "x-adapter.js"));
  runScript(context, path.join("adapters", "linkedin-adapter.js"));
  runScript(context, path.join("adapters", "facebook-adapter.js"));
  runScript(context, path.join("adapters", "instagram-adapter.js"));

  assert.deepEqual(
    [...context.AkuSourceAdapters.capabilities()].map(({ source, version }) => ({ source, version })),
    [
      { source: "x", version: "x-dom-v22" },
      { source: "linkedin", version: "linkedin-dom-v20" },
      { source: "facebook", version: "facebook-dom-v18" },
      { source: "instagram", version: "instagram-dom-v5" },
    ],
  );
  assert.equal(
    context.AkuSourceAdapters.capabilities()[0].actions.includes("diagnose_readiness"),
    true,
  );
  assert.equal(
    context.AkuSourceAdapters.capabilities()[1].actions.includes("diagnose_readiness"),
    false,
  );
  assert.equal(context.AkuSourceAdapters.get("x").matchesPage(), true);
  assert.equal(context.AkuSourceAdapters.get("linkedin").matchesPage(), false);
  assert.equal(context.AkuSourceAdapters.get("x").qualityProfile, "social-post-v2");
  assert.equal(context.AkuSourceAdapters.capabilities()[0].qualityProfile, "social-post-v2");
  assert.equal(
    context.AkuSourceAdapters.capabilities()[0].mediaAcquisitionVersion,
    "x-media-acquisition-v2",
  );
  assert.equal(context.AkuSourceAdapters.capabilities()[0].scrollStepMultiplier, 1);
  assert.equal(context.AkuSourceAdapters.capabilities()[2].scrollStepMultiplier, 2);
  assert.equal(context.AkuSourceAdapters.capabilities()[0].scrollStrategy, "viewport");
  assert.equal(context.AkuSourceAdapters.capabilities()[2].scrollStrategy, "next_candidate");
  assert.equal(context.AkuSourceAdapters.capabilities()[0].contentFamily, "feed_post");
  assert.deepEqual(
    [...context.AkuSourceAdapters.capabilities()[2].evidenceModalities],
    ["text", "image", "video", "attachment", "quoted_post"],
  );
});

test("X and Instagram diagnose unhydrated feed shells through the generic contract", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  runScript(context, path.join("adapters", "x-adapter.js"));
  runScript(context, path.join("adapters", "instagram-adapter.js"));

  for (const source of ["x", "instagram"]) {
    const assessment = context.AkuSourceAdapters.assessReadiness(source, {
      state: "selector_mismatch",
      feedRootPresent: true,
      documentReadyState: "complete",
      selectorCandidateCount: 0,
      structuralCandidateCount: 0,
    });
    assert.equal(assessment.state, "selector_mismatch");
    assert.equal(assessment.diagnosis, "feed_shell_unhydrated");
    assert.deepEqual(JSON.parse(JSON.stringify(assessment.recovery)), {
      action: "recreate_managed_surface",
      ...(source === "instagram" ? { inPageAction: "reset_feed_top" } : {}),
      reason: "feed_shell_unhydrated",
      maxAttempts: 1,
    });
  }

  const hydrating = context.AkuSourceAdapters.assessReadiness("instagram", {
    state: "feed_empty",
    feedRootPresent: true,
    documentReadyState: "complete",
    selectorCandidateCount: 0,
    structuralCandidateCount: 2,
  });
  assert.equal(hydrating.state, "feed_hydrating");
  assert.equal(hydrating.diagnosis, "post_permalink_unhydrated");
  assert.equal(hydrating.recovery.inPageAction, "reset_feed_top");

  const settledContractMismatch = context.AkuSourceAdapters.assessReadiness("instagram", {
    state: "selector_mismatch",
    feedRootPresent: true,
    documentReadyState: "complete",
    selectorCandidateCount: 0,
    structuralCandidateCount: 0,
    visualHydrationReady: true,
  });
  assert.equal(settledContractMismatch.state, "selector_mismatch");
  assert.equal(settledContractMismatch.diagnosis, "dom_contract_mismatch");
  assert.equal(settledContractMismatch.recovery, null);
});

test("generic readiness contract rejects unallowlisted or unimplemented in-page recovery", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  const fixture = {
    source: "fixture",
    version: "fixture-v1",
    mediaHosts: ["example.test"],
    qualityProfile: "social-post-v2",
    evidenceProfile: { contentFamily: "feed_post", modalities: ["text"] },
    qualitySelectors: {},
    freshness: {
      version: "fixture-freshness-v1",
      revealObservationMs: 5_000,
      pendingContentPattern: /new posts/i,
    },
    mediaAcquisition: {
      version: "fixture-media-v1",
      maxAttempts: 1,
      settleMs: 500,
      detectExpectedKinds() { return []; },
      extractCandidates() { return []; },
    },
    matchesPage() { return true; },
    discoverCandidates() { return { candidates: [] }; },
    findAuthor() { return ""; },
    extractSemantics() { return {}; },
    assessReadiness() {
      return {
        state: "selector_mismatch",
        diagnosis: "fixture_unready",
        recovery: {
          action: "recreate_managed_surface",
          inPageAction: "reset_feed_top",
          reason: "fixture_unready",
          maxAttempts: 1,
        },
      };
    },
  };
  context.AkuSourceAdapters.register(fixture);
  assert.throws(
    () => context.AkuSourceAdapters.assessReadiness("fixture", { state: "selector_mismatch" }),
    /invalid in-page readiness recovery hint/,
  );
  context.AkuSourceAdapters.register({
    ...fixture,
    source: "fixture-unknown-action",
    recoverReadiness() { return { attempted: false }; },
    assessReadiness() {
      return {
        state: "selector_mismatch",
        diagnosis: "fixture_unready",
        recovery: {
          action: "recreate_managed_surface",
          inPageAction: "navigate_somewhere",
          reason: "fixture_unready",
          maxAttempts: 1,
        },
      };
    },
  });
  assert.throws(
    () => context.AkuSourceAdapters.assessReadiness(
      "fixture-unknown-action",
      { state: "selector_mismatch" },
    ),
    /invalid in-page readiness recovery hint/,
  );
});

test("adapter registry rejects duplicates and unknown sources", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  context.AkuSourceAdapters.register({
    source: "fixture",
    version: "fixture-v1",
    mediaHosts: ["example.test"],
    qualityProfile: "social-post-v2",
    evidenceProfile: {
      contentFamily: "feed_post",
      modalities: ["text"],
    },
    qualitySelectors: {},
    freshness: {
      version: "fixture-freshness-v1",
      revealObservationMs: 5_000,
      pendingContentPattern: /new posts/i,
    },
    mediaAcquisition: {
      version: "fixture-media-v1",
      maxAttempts: 1,
      settleMs: 500,
      detectExpectedKinds() { return []; },
      extractCandidates() { return []; },
    },
    matchesPage() { return true; },
    discoverCandidates() { return { candidates: [] }; },
    findAuthor() { return ""; },
    extractSemantics() { return {}; },
  });
  assert.throws(() => context.AkuSourceAdapters.register({ source: "fixture" }), /already registered/);
  assert.throws(() => context.AkuSourceAdapters.get("missing"), /no loaded source adapter/);
});

test("generic platform-origin contract preserves kind and object scope", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  const label = {
    innerText: "AI info",
    textContent: "AI info",
    getAttribute(name) {
      return name === "aria-label" ? "AI info" : null;
    },
  };
  const container = {
    querySelectorAll() { return [label]; },
  };
  const signals = context.AkuSourceAdapters.extractOriginSignals(container, {
    source: "facebook",
    definitions: [{
      kind: "platform_ai_label",
      scope: "attached_media",
      labels: ["AI info"],
    }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(signals)), [{
    kind: "platform_ai_label",
    scope: "attached_media",
    authority: "platform",
    label: "AI info",
    source: "facebook",
  }]);
});

test("every source exposes platform origin labels through one presentation field", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  runScript(context, path.join("adapters", "x-adapter.js"));
  runScript(context, path.join("adapters", "linkedin-adapter.js"));
  runScript(context, path.join("adapters", "facebook-adapter.js"));
  runScript(context, path.join("adapters", "instagram-adapter.js"));
  const compactText = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
  const helpers = { compactText, normalizeHttpUrl: (value) => value ?? "" };
  for (const [source, label, expectedKind] of [
    ["x", "Made with AI", "platform_ai_label"],
    ["linkedin", "Content Credentials", "content_credentials"],
    ["facebook", "AI info", "platform_ai_label"],
    ["instagram", "AI info", "platform_ai_label"],
  ]) {
    const element = {
      innerText: label,
      textContent: label,
      getAttribute(name) { return name === "aria-label" ? label : null; },
    };
    const container = {
      innerText: "",
      querySelector() { return null; },
      querySelectorAll(selector) {
        return selector === '[aria-label],[title],[role="button"],button,a' ? [element] : [];
      },
    };
    const presentation = context.AkuSourceAdapters.get(source).extractPresentation(container, helpers);
    assert.equal(presentation.originSignals[0]?.kind, expectedKind, `${source} signal`);
    assert.equal(presentation.originSignals[0]?.scope, "attached_media", `${source} scope`);
  }
});

test("a reinjected adapter runtime replaces the stale registry generation", () => {
  const context = createBrowserContext();
  const previous = { runtimeRevision: "source-adapters-v3" };
  context.AkuSourceAdapters = previous;
  runScript(context, "source-adapter-runtime.js");
  assert.notEqual(context.AkuSourceAdapters, previous);
  assert.equal(context.AkuSourceAdapters.runtimeRevision, "source-adapters-v17");
  assert.deepEqual([...context.AkuSourceAdapters.capabilities()], []);
});

test("the complete adapter bundle can replace its current registry generation", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  runScript(context, path.join("adapters", "x-adapter.js"));
  runScript(context, path.join("adapters", "linkedin-adapter.js"));
  runScript(context, path.join("adapters", "facebook-adapter.js"));
  runScript(context, path.join("adapters", "instagram-adapter.js"));
  const previous = context.AkuSourceAdapters;

  runScript(context, "source-adapter-runtime.js");
  runScript(context, path.join("adapters", "x-adapter.js"));
  runScript(context, path.join("adapters", "linkedin-adapter.js"));
  runScript(context, path.join("adapters", "facebook-adapter.js"));
  runScript(context, path.join("adapters", "instagram-adapter.js"));

  assert.notEqual(context.AkuSourceAdapters, previous);
  assert.deepEqual(
    [...context.AkuSourceAdapters.capabilities()].map(({ source, version }) => ({ source, version })),
    [
      { source: "x", version: "x-dom-v22" },
      { source: "linkedin", version: "linkedin-dom-v20" },
      { source: "facebook", version: "facebook-dom-v18" },
      { source: "instagram", version: "instagram-dom-v5" },
    ],
  );
});

function createBrowserContext() {
  const document = {
    body: {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = {
    document,
    window: {
      document,
      location: { hostname: "x.com", pathname: "/home" },
    },
    URL,
  };
  context.globalThis = context;
  return vm.createContext(context);
}

function runScript(context, file) {
  vm.runInContext(fs.readFileSync(path.join(projectRoot, file), "utf8"), context);
}
