// Shared by the extension catalog, the Headless worker VM and its page scripts.
(() => {
  const routes = Object.freeze({
    x: Object.freeze({
      feedUrl: "https://x.com/home",
      hostnames: Object.freeze(["x.com"]),
      canonicalFeedPath: /^\/home$/,
    }),
    linkedin: Object.freeze({
      feedUrl: "https://www.linkedin.com/feed/",
      hostnames: Object.freeze(["www.linkedin.com"]),
      canonicalFeedPath: /^\/feed\/?$/,
      managedFeedRedirectPath: /^\/feed\/foryou\/?$/,
    }),
    facebook: Object.freeze({
      feedUrl: "https://www.facebook.com/",
      hostnames: Object.freeze(["www.facebook.com", "facebook.com"]),
      canonicalFeedPath: /^\/$/,
      managedFeedRedirectPath: /^\/home\.php$/,
    }),
    instagram: Object.freeze({
      feedUrl: "https://www.instagram.com/",
      hostnames: Object.freeze(["www.instagram.com", "instagram.com"]),
      canonicalFeedPath: /^\/$/,
    }),
  });

  function matchesHeadlessFeed(source, rawUrl) {
    if (!Object.hasOwn(routes, source) || typeof rawUrl !== "string" || rawUrl.length > 2048) return false;
    const route = routes[source];
    const entry = new URL(route.feedUrl);
    if (!rawUrl.startsWith(`${entry.origin}/`)) return false;
    const rawPath = rawUrl.slice(entry.origin.length).split(/[?#]/, 1)[0];
    try {
      const url = new URL(rawUrl);
      return url.origin === entry.origin && rawPath === url.pathname &&
        (rawPath === entry.pathname || route.managedFeedRedirectPath?.test(rawPath) === true);
    } catch { return false; }
  }

  globalThis.AkuSourceFeedRoutes = Object.freeze({ routes, matchesHeadlessFeed });
})();
