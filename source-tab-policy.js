const FEED_URLS = {
  x: "https://x.com/home",
  linkedin: "https://www.linkedin.com/feed/",
};

export function expectedFeedUrl(source) {
  return FEED_URLS[source] ?? null;
}

export function isCanonicalFeedUrl(rawUrl, source) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (source === "x") {
      return url.hostname === "x.com" && url.pathname === "/home";
    }
    if (source === "linkedin") {
      return url.hostname === "www.linkedin.com" && /^\/feed\/?$/.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
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
