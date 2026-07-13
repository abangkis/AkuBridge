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

  assert.deepEqual(
    [...context.AkuSourceAdapters.capabilities()].map(({ source, version }) => ({ source, version })),
    [
      { source: "x", version: "x-dom-v2" },
      { source: "linkedin", version: "linkedin-dom-v5" },
    ],
  );
  assert.equal(context.AkuSourceAdapters.get("x").matchesPage(), true);
  assert.equal(context.AkuSourceAdapters.get("linkedin").matchesPage(), false);
});

test("adapter registry rejects duplicates and unknown sources", () => {
  const context = createBrowserContext();
  runScript(context, "source-adapter-runtime.js");
  context.AkuSourceAdapters.register({
    source: "fixture",
    version: "fixture-v1",
    matchesPage() { return true; },
    discoverCandidates() { return { candidates: [] }; },
    findAuthor() { return ""; },
    extractSemantics() { return {}; },
  });
  assert.throws(() => context.AkuSourceAdapters.register({ source: "fixture" }), /already registered/);
  assert.throws(() => context.AkuSourceAdapters.get("missing"), /no loaded source adapter/);
});

test("a reinjected adapter runtime replaces the stale registry generation", () => {
  const context = createBrowserContext();
  const previous = { runtimeRevision: "stale-fixture" };
  context.AkuSourceAdapters = previous;
  runScript(context, "source-adapter-runtime.js");
  assert.notEqual(context.AkuSourceAdapters, previous);
  assert.equal(context.AkuSourceAdapters.runtimeRevision, "source-adapters-v3");
  assert.deepEqual([...context.AkuSourceAdapters.capabilities()], []);
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
