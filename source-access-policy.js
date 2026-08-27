export const SOURCE_ACCESS_STATE_KEY = "akuBrowserSourceAccess";
export const SOURCE_ACCESS_SELECTION_KEY = "akuBrowserSourceAccessSelection";
export const SOURCE_ACCESS_SELECTION_SCHEMA_VERSION = 2;
export const SOURCE_DISCLOSURE_VERSION = 1;

const SOURCE_ACCESS = Object.freeze({
  x: Object.freeze({
    displayName: "X",
    origins: Object.freeze(["https://x.com/*"]),
    scripts: Object.freeze([
      Object.freeze({
        id: "aku-source-x-response-main",
        matches: ["https://x.com/home*", "https://x.com/*/status/*"],
        js: ["x-response-evidence-adapter.js"],
        runAt: "document_start",
        world: "MAIN",
      }),
      Object.freeze({
        id: "aku-source-x-media-isolated",
        matches: ["https://x.com/home*", "https://x.com/*/status/*"],
        js: ["x-media-evidence-runtime.js"],
        runAt: "document_start",
        world: "ISOLATED",
      }),
      Object.freeze({
        id: "aku-source-x-feed",
        matches: ["https://x.com/home*", "https://x.com/*/status/*"],
        js: [
          "bounded-capture-policy.js",
          "capture-quality-policy.js",
          "source-adapter-runtime.js",
          "media-post-processor.js",
          "adapters/x-adapter.js",
          "source-freshness-runtime.js",
          "media-acquisition-engine.js",
          "content-script.js",
        ],
        runAt: "document_idle",
        world: "ISOLATED",
      }),
    ]),
  }),
  linkedin: Object.freeze({
    displayName: "LinkedIn",
    origins: Object.freeze(["https://www.linkedin.com/*"]),
    scripts: Object.freeze([
      Object.freeze({
        id: "aku-source-linkedin-feed",
        matches: [
          "https://www.linkedin.com/feed/*",
          "https://www.linkedin.com/posts/*",
        ],
        js: [
          "bounded-capture-policy.js",
          "capture-quality-policy.js",
          "linkedin-permalink-policy.js",
          "linkedin-timestamp-policy.js",
          "source-adapter-runtime.js",
          "media-post-processor.js",
          "adapters/linkedin-adapter.js",
          "source-freshness-runtime.js",
          "media-acquisition-engine.js",
          "content-script.js",
        ],
        runAt: "document_idle",
        world: "ISOLATED",
      }),
    ]),
  }),
  facebook: Object.freeze({
    displayName: "Facebook",
    origins: Object.freeze([
      "https://www.facebook.com/*",
      "https://facebook.com/*",
    ]),
    scripts: Object.freeze([
      Object.freeze({
        id: "aku-source-facebook-feed",
        matches: ["https://www.facebook.com/", "https://facebook.com/"],
        js: [
          "bounded-capture-policy.js",
          "capture-quality-policy.js",
          "source-adapter-runtime.js",
          "media-post-processor.js",
          "adapters/facebook-adapter.js",
          "source-freshness-runtime.js",
          "media-acquisition-engine.js",
          "content-script.js",
        ],
        runAt: "document_idle",
        world: "ISOLATED",
      }),
    ]),
  }),
  instagram: Object.freeze({
    displayName: "Instagram",
    defaultSelected: true,
    origins: Object.freeze([
      "https://www.instagram.com/*",
      "https://instagram.com/*",
    ]),
    scripts: Object.freeze([
      Object.freeze({
        id: "aku-source-instagram-feed",
        matches: ["https://www.instagram.com/*", "https://instagram.com/*"],
        js: [
          "bounded-capture-policy.js",
          "capture-quality-policy.js",
          "source-adapter-runtime.js",
          "media-post-processor.js",
          "adapters/instagram-adapter.js",
          "source-freshness-runtime.js",
          "media-acquisition-engine.js",
          "content-script.js",
        ],
        runAt: "document_idle",
        world: "ISOLATED",
      }),
    ]),
  }),
});

export function sourceAccessDefinitions() {
  return Object.entries(SOURCE_ACCESS).map(([id, definition]) => ({
    id,
    displayName: definition.displayName,
    origins: [...definition.origins],
  }));
}

export function sourceAccessDefinition(source) {
  const definition = SOURCE_ACCESS[source];
  if (!definition) return null;
  return {
    id: source,
    displayName: definition.displayName,
    origins: [...definition.origins],
  };
}

export function setupSelectedSources(grantedSources, savedSelection) {
  const allSources = Object.keys(SOURCE_ACCESS);
  if (!savedSelection || ![1, SOURCE_ACCESS_SELECTION_SCHEMA_VERSION].includes(savedSelection.schemaVersion) || !Array.isArray(savedSelection.selectedSources)) {
    return allSources.filter((source) => SOURCE_ACCESS[source].defaultSelected !== false);
  }
  if (legacyDefaultSelection(savedSelection)) {
    return allSources.filter((source) => SOURCE_ACCESS[source].defaultSelected !== false);
  }
  const selected = new Set(normalizeSources(savedSelection.selectedSources));
  return normalizeSources(grantedSources).filter((source) => selected.has(source));
}

export function sourceAccessSelectionNeedsDefaultMigration(savedSelection) {
  return legacyDefaultSelection(savedSelection);
}

function legacyDefaultSelection(savedSelection) {
  const selected = savedSelection?.selectedSources;
  return savedSelection?.schemaVersion === 1
    && Array.isArray(selected)
    && selected.length === 3
    && selected[0] === "x"
    && selected[1] === "linkedin"
    && selected[2] === "facebook";
}

export function originsForSources(sources) {
  return [...new Set(normalizeSources(sources).flatMap((source) => SOURCE_ACCESS[source].origins))];
}

export function sourcesForGrantedOrigins(origins) {
  const granted = new Set(origins ?? []);
  return Object.keys(SOURCE_ACCESS).filter((source) =>
    SOURCE_ACCESS[source].origins.every((origin) => granted.has(origin)));
}

export function registeredScriptsForSources(sources) {
  return normalizeSources(sources).flatMap((source) =>
    SOURCE_ACCESS[source].scripts.map((script) => ({
      ...script,
      matches: [...script.matches],
      js: [...script.js],
      persistAcrossSessions: true,
    })));
}

export function allRegisteredSourceScriptIds() {
  return Object.values(SOURCE_ACCESS).flatMap((definition) =>
    definition.scripts.map((script) => script.id));
}

export async function sourceAccessGranted(chromeApi, source) {
  const definition = SOURCE_ACCESS[source];
  if (!definition) return false;
  return chromeApi.permissions.contains({ origins: [...definition.origins] });
}

// revokeAllSourceAccess removes every optional source host permission and
// re-reconciles dynamic content scripts against the now-empty grant set.
// Full reset uses this so a clean database is paired with a clean capture
// surface instead of resurrecting the previous setup's grants.
export async function revokeAllSourceAccess(chromeApi) {
  const origins = originsForSources(Object.keys(SOURCE_ACCESS));
  const granted = await chromeApi.permissions.getAll();
  const removable = origins.filter((origin) => (granted.origins ?? []).includes(origin));
  if (removable.length > 0) {
    await chromeApi.permissions.remove({ origins: removable });
  }
  return reconcileRegisteredSourceScripts(chromeApi);
}

export async function reconcileRegisteredSourceScripts(chromeApi, now = () => Date.now()) {
  const permissions = await chromeApi.permissions.getAll();
  const sources = sourcesForGrantedOrigins(permissions.origins);
  const scriptIds = allRegisteredSourceScriptIds();
  const existing = await chromeApi.scripting.getRegisteredContentScripts({ ids: scriptIds });
  if (existing.length > 0) {
    await chromeApi.scripting.unregisterContentScripts({
      ids: existing.map((script) => script.id),
    });
  }
  const scripts = registeredScriptsForSources(sources);
  if (scripts.length > 0) {
    await chromeApi.scripting.registerContentScripts(scripts);
  }
  const readiness = await sourceAccessReadiness(chromeApi);
  const state = {
    schemaVersion: 1,
    disclosureVersion: SOURCE_DISCLOSURE_VERSION,
    grantedSources: sources,
    sources: readiness,
    observedAt: new Date(now()).toISOString(),
  };
  await chromeApi.storage.local.set({ [SOURCE_ACCESS_STATE_KEY]: state });
  return state;
}

export async function sourceAccessReadiness(chromeApi) {
  const permissions = await chromeApi.permissions.getAll();
  const grantedSources = new Set(sourcesForGrantedOrigins(permissions.origins));
  const registered = await chromeApi.scripting.getRegisteredContentScripts({
    ids: allRegisteredSourceScriptIds(),
  });
  const registeredIds = new Set(registered.map((script) => script.id));
  return Object.entries(SOURCE_ACCESS).map(([source, definition]) => {
    const permissionGranted = grantedSources.has(source);
    const scriptRegistered = definition.scripts.every((script) => registeredIds.has(script.id));
    return {
      source,
      permissionGranted,
      scriptRegistered,
      ready: permissionGranted && scriptRegistered,
      reason: !permissionGranted
        ? "permission_not_granted"
        : scriptRegistered ? "ready" : "content_script_not_registered",
    };
  });
}

function normalizeSources(sources) {
  return [...new Set(sources ?? [])].filter((source) => Object.hasOwn(SOURCE_ACCESS, source));
}
