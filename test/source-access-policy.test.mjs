import test from "node:test";
import assert from "node:assert/strict";
import {
  allRegisteredSourceScriptIds,
  originsForSources,
  reconcileRegisteredSourceScripts,
  registeredScriptsForSources,
  sourceAccessGranted,
  sourcesForGrantedOrigins,
} from "../source-access-policy.js";

test("source permissions are exact, optional, and independently selectable", () => {
  assert.deepEqual(originsForSources(["x"]), ["https://x.com/*"]);
  assert.deepEqual(originsForSources(["linkedin"]), ["https://www.linkedin.com/*"]);
  assert.deepEqual(originsForSources(["facebook"]), [
    "https://www.facebook.com/*",
    "https://facebook.com/*",
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
    || script.js.includes("adapters/facebook-adapter.js")), false);
});

test("reconciliation derives authority from Chrome grants, not message input", async () => {
  const unregistered = [];
  const registered = [];
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
        return allRegisteredSourceScriptIds().map((id) => ({ id }));
      },
      async unregisterContentScripts(value) {
        unregistered.push(...value.ids);
      },
      async registerContentScripts(value) {
        registered.push(...value);
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
  assert.equal(storageWrites.length, 1);
  assert.equal(await sourceAccessGranted(chromeApi, "linkedin"), true);
  assert.equal(await sourceAccessGranted(chromeApi, "x"), false);
});
