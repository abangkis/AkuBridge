import test from "node:test";
import assert from "node:assert/strict";
import {
  allRegisteredSourceScriptIds,
  originsForSources,
  reconcileRegisteredSourceScripts,
  registeredScriptsForSources,
  setupSelectedSources,
  sourceAccessDefinition,
  sourceAccessSelectionNeedsDefaultMigration,
  sourceAccessGranted,
  sourceAccessReadiness,
  sourcesForGrantedOrigins,
} from "../source-access-policy.js";

test("setup preselects every registered source by default", () => {
  assert.deepEqual(setupSelectedSources([], undefined), ["x", "linkedin", "facebook", "instagram"]);
  const legacyDefaults = { schemaVersion: 1, selectedSources: ["x", "linkedin", "facebook"] };
  assert.equal(sourceAccessSelectionNeedsDefaultMigration(legacyDefaults), true);
  assert.deepEqual(setupSelectedSources(["x", "linkedin", "facebook"], legacyDefaults), ["x", "linkedin", "facebook", "instagram"]);
  assert.deepEqual(
    setupSelectedSources(["x", "linkedin"], { schemaVersion: 1, selectedSources: ["linkedin"] }),
    ["linkedin"],
  );
  assert.deepEqual(
    setupSelectedSources([], { schemaVersion: 1, selectedSources: [] }),
    [],
  );
});

test("source permissions are exact, optional, and independently selectable", () => {
  assert.deepEqual(sourceAccessDefinition("x"), {
    id: "x",
    displayName: "X",
    origins: ["https://x.com/*"],
  });
  assert.equal(sourceAccessDefinition("unknown"), null);
  assert.deepEqual(originsForSources(["x"]), ["https://x.com/*"]);
  assert.deepEqual(originsForSources(["linkedin"]), ["https://www.linkedin.com/*"]);
  assert.deepEqual(originsForSources(["facebook"]), [
    "https://www.facebook.com/*",
    "https://facebook.com/*",
  ]);
  assert.deepEqual(originsForSources(["instagram"]), [
    "https://www.instagram.com/*",
    "https://instagram.com/*",
  ]);
  assert.deepEqual(
    sourcesForGrantedOrigins(["https://x.com/*", "https://www.linkedin.com/*"]),
    ["x", "linkedin"],
  );
  assert.deepEqual(
    sourcesForGrantedOrigins(["https://www.facebook.com/*"]),
    [],
    "partial Facebook authority must not activate the source",
  );
});

test("registered scripts contain packaged logic only for approved sources", () => {
  const scripts = registeredScriptsForSources(["x"]);
  assert.deepEqual(scripts.map((script) => script.id), [
    "aku-source-x-response-main",
    "aku-source-x-media-isolated",
    "aku-source-x-feed",
  ]);
  assert.equal(scripts.every((script) => script.persistAcrossSessions === true), true);
  assert.equal(scripts.every((script) =>
    script.js.every((file) => !/^(?:https?:|data:)/.test(file))), true);
  assert.equal(scripts.some((script) => script.world === "MAIN"), true);
  assert.equal(scripts.some((script) =>
    script.js.includes("adapters/linkedin-adapter.js")
    || script.js.includes("adapters/facebook-adapter.js")
    || script.js.includes("adapters/instagram-adapter.js")), false);
});

test("reconciliation derives authority from Chrome grants, not message input", async () => {
  const unregistered = [];
  const registered = [];
  const registeredIds = new Set(allRegisteredSourceScriptIds());
  const storageWrites = [];
  const chromeApi = {
    permissions: {
      async getAll() {
        return { origins: ["https://www.linkedin.com/*"] };
      },
      async contains(request) {
        return request.origins[0] === "https://www.linkedin.com/*";
      },
    },
    scripting: {
      async getRegisteredContentScripts() {
        return [...registeredIds].map((id) => ({ id }));
      },
      async unregisterContentScripts(value) {
        unregistered.push(...value.ids);
        value.ids.forEach((id) => registeredIds.delete(id));
      },
      async registerContentScripts(value) {
        registered.push(...value);
        value.forEach((script) => registeredIds.add(script.id));
      },
    },
    storage: {
      local: {
        async set(value) {
          storageWrites.push(value);
        },
      },
    },
  };

  const state = await reconcileRegisteredSourceScripts(
    chromeApi,
    () => Date.parse("2026-07-28T12:00:00.000Z"),
  );

  assert.deepEqual(unregistered, allRegisteredSourceScriptIds());
  assert.deepEqual(registered.map((script) => script.id), ["aku-source-linkedin-feed"]);
  assert.deepEqual(state.grantedSources, ["linkedin"]);
  assert.deepEqual(state.sources, [
    { source: "x", permissionGranted: false, scriptRegistered: false, ready: false, reason: "permission_not_granted" },
    { source: "linkedin", permissionGranted: true, scriptRegistered: true, ready: true, reason: "ready" },
    { source: "facebook", permissionGranted: false, scriptRegistered: false, ready: false, reason: "permission_not_granted" },
    { source: "instagram", permissionGranted: false, scriptRegistered: false, ready: false, reason: "permission_not_granted" },
  ]);
  assert.equal(storageWrites.length, 1);
  assert.equal(await sourceAccessGranted(chromeApi, "linkedin"), true);
  assert.equal(await sourceAccessGranted(chromeApi, "x"), false);
});

test("readiness distinguishes granted permission from registered capture scripts", async () => {
  const chromeApi = {
    permissions: {
      async getAll() {
        return { origins: ["https://x.com/*", "https://www.linkedin.com/*"] };
      },
    },
    scripting: {
      async getRegisteredContentScripts() {
        return registeredScriptsForSources(["linkedin"]);
      },
    },
  };
  const readiness = await sourceAccessReadiness(chromeApi);
  assert.deepEqual(readiness.find((item) => item.source === "x"), {
    source: "x",
    permissionGranted: true,
    scriptRegistered: false,
    ready: false,
    reason: "content_script_not_registered",
  });
  assert.equal(readiness.find((item) => item.source === "linkedin").ready, true);
});
