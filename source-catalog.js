const SOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "x",
    displayName: "X",
    adapterVersion: "x-dom-v20",
    adapterScript: "adapters/x-adapter.js",
    supportScripts: Object.freeze(["x-media-evidence-runtime.js"]),
    feedUrl: "https://x.com/home",
    matchPatterns: Object.freeze(["https://x.com/*"]),
    hostnames: Object.freeze(["x.com"]),
    canonicalFeedPath: /^\/home$/,
    nativePostPath: /\/status\//,
    requiresVisualHydration: true,
    mediaEvidenceAdapterVersion: "x-response-evidence-v2",
    structuredMediaCollector: "x_response",
    structuredMediaPayloadField: "xStructuredMediaEvidence",
    hydration: Object.freeze({ defaultTimeoutMs: 12_000, minTimeoutMs: 7_000, maxTimeoutMs: 17_000 }),
    readiness: Object.freeze({ initialTimeoutMs: 12_000, activateWhenBackground: true }),
  }),
  Object.freeze({
    id: "linkedin",
    displayName: "LinkedIn",
    adapterVersion: "linkedin-dom-v16",
    adapterScript: "adapters/linkedin-adapter.js",
    supportScripts: Object.freeze(["linkedin-permalink-policy.js", "linkedin-timestamp-policy.js"]),
    feedUrl: "https://www.linkedin.com/feed/",
    matchPatterns: Object.freeze(["https://www.linkedin.com/*"]),
    hostnames: Object.freeze(["www.linkedin.com"]),
    canonicalFeedPath: /^\/feed\/?$/,
    nativePostPath: /\/(?:posts\/|feed\/update\/)/,
    hydration: Object.freeze({ defaultTimeoutMs: 18_000, minTimeoutMs: 13_000, maxTimeoutMs: 23_000 }),
    readiness: Object.freeze({ initialTimeoutMs: 3_000, retryAfterActivationMs: 15_000 }),
  }),
  Object.freeze({
    id: "facebook",
    displayName: "Facebook",
    adapterVersion: "facebook-dom-v9",
    adapterScript: "adapters/facebook-adapter.js",
    supportScripts: Object.freeze([]),
    feedUrl: "https://www.facebook.com/",
    matchPatterns: Object.freeze(["https://www.facebook.com/*", "https://facebook.com/*"]),
    hostnames: Object.freeze(["www.facebook.com", "facebook.com"]),
    canonicalFeedPath: /^\/$/,
    nativePostPath: /\/(?:posts\/|permalink\/|story\.php|photo|videos\/)/,
    hydration: Object.freeze({ defaultTimeoutMs: 25_000, minTimeoutMs: 20_000, maxTimeoutMs: 30_000 }),
    readiness: Object.freeze({ initialTimeoutMs: 25_000 }),
    captureRecovery: Object.freeze({ emptyObservation: "reload_managed_once" }),
  }),
]);

export function sourceDefinitions() {
  return [...SOURCE_DEFINITIONS];
}

export function sourceDefinition(source) {
  return SOURCE_DEFINITIONS.find((definition) => definition.id === source) ?? null;
}

export function sourceIds() {
  return SOURCE_DEFINITIONS.map((definition) => definition.id);
}

export function sourceAdapterVersions() {
  return Object.fromEntries(SOURCE_DEFINITIONS.map((definition) => [definition.id, definition.adapterVersion]));
}

export function mediaEvidenceAdapterVersions() {
  return Object.fromEntries(SOURCE_DEFINITIONS.flatMap((definition) =>
    definition.mediaEvidenceAdapterVersion
      ? [[definition.id, definition.mediaEvidenceAdapterVersion]]
      : [],
  ));
}

export function sourceAdapterScripts() {
  return SOURCE_DEFINITIONS.map((definition) => definition.adapterScript);
}

export function sourceRuntimeScripts() {
  return SOURCE_DEFINITIONS.flatMap((definition) => [
    ...(definition.supportScripts ?? []),
    definition.adapterScript,
  ]);
}

export function sourceRequiresVisualHydration(source) {
  return sourceDefinition(source)?.requiresVisualHydration === true;
}

export function sourceHydrationTimeout(source, requestedTimeoutMs) {
  const policy = sourceDefinition(source)?.hydration;
  if (!policy) return 12_000;
  const requested = Number(requestedTimeoutMs);
  if (!Number.isFinite(requested)) return policy.defaultTimeoutMs;
  const rounded = Math.round(requested / 1_000) * 1_000;
  return Math.min(policy.maxTimeoutMs, Math.max(policy.minTimeoutMs, rounded));
}

export function sourceMatchPatterns() {
  return [...new Set(SOURCE_DEFINITIONS.flatMap((definition) => definition.matchPatterns))];
}

export function matchPatternsFor(source) {
  return [...(sourceDefinition(source)?.matchPatterns ?? [])];
}

export function expectedFeedUrlFor(source) {
  return sourceDefinition(source)?.feedUrl ?? null;
}

export function sourceForUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return null;
    return SOURCE_DEFINITIONS.find((definition) => definition.hostnames.includes(url.hostname))?.id ?? null;
  } catch {
    return null;
  }
}

export function isCanonicalFeed(rawUrl, source) {
  const definition = sourceDefinition(source);
  if (!definition || !rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" &&
      definition.hostnames.includes(url.hostname) &&
      definition.canonicalFeedPath.test(url.pathname);
  } catch {
    return false;
  }
}

export function isNativePostUrl(rawUrl, source) {
  const definition = sourceDefinition(source);
  if (!definition || !rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" &&
      definition.hostnames.includes(url.hostname) &&
      definition.nativePostPath.test(url.pathname);
  } catch {
    return false;
  }
}
