import {
  expectedFeedUrlFor,
  isCanonicalFeed,
  isManagedFeedNavigation,
} from "./source-catalog.js";

export function expectedFeedUrl(source) {
  return expectedFeedUrlFor(source);
}

export function isCanonicalFeedUrl(rawUrl, source) {
  if (!rawUrl) return false;
  return isCanonicalFeed(rawUrl, source);
}

export function isBridgeOwnedFeedUrl(rawUrl, source) {
  if (!rawUrl) return false;
  return isManagedFeedNavigation(rawUrl, source);
}

export function chooseSourceTab(tabs, { source, mode }) {
  const usable = tabs
    .filter((tab) => tab.id && !tab.discarded)
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (mode === "catch_up") {
    return usable.find((tab) => isCanonicalFeedUrl(tab.url, source)) ?? null;
  }

  return usable.find((tab) => tab.active) ?? usable[0] ?? null;
}
