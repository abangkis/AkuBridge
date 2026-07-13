(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  registry.register({
    source: "x",
    version: "x-dom-v3",
    matchesPage: () => window.location.hostname === "x.com",
    loginRequired: () => false,
    feedRootPresent: () => Boolean(document.querySelector("main")),
    discoverCandidates: ({ uniqueElements }) => {
      const primary = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const fallback = [...document.querySelectorAll("main article")];
      const candidates = uniqueElements([...primary, ...fallback]);
      return {
        candidates,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: 0,
        strategy: primary.length > 0 ? "tweet_testid" : fallback.length > 0 ? "main_article" : "none",
        selectorCounts: { tweet_testid: primary.length, main_article: fallback.length },
      };
    },
    findAuthor: (container, { compactText }) =>
      compactText(container.querySelector('[data-testid="User-Name"]')?.innerText).slice(0, 300),
    findAvatar: (container, { normalizeHttpUrl }) => {
      const image = container.querySelector('[data-testid^="UserAvatar-Container-"] img');
      return normalizeHttpUrl(image?.currentSrc || image?.src);
    },
    contentRootSelector: '[data-testid="tweetText"]',
    extractText: (container, { compactText }) =>
      compactText(container.querySelector('[data-testid="tweetText"]')?.innerText) ||
      compactText(container.innerText),
    extractSemantics: (container, { compactText, normalizeHttpUrl }) => {
      const socialContext = compactText(
        container.querySelector('[data-testid="socialContext"]')?.innerText,
      );
      const quoted = container.querySelector('[role="link"][href*="/status/"] article, [data-testid="quoteTweet"]');
      const reply = compactText(container.innerText).match(/^Replying to\b/i);
      const relationshipType = quoted ? "quote" : socialContext ? "repost" : reply ? "reply" : "original";
      const parentLink = [...container.querySelectorAll('a[href*="/status/"]')]
        .map((anchor) => normalizeHttpUrl(anchor.href))
        .find(Boolean) ?? null;
      return {
        contentKind: container.querySelector(
          'video, [data-testid="videoPlayer"], [data-testid="videoComponent"]',
        ) ? "video" : "post",
        relationshipType,
        parentPermalink: relationshipType === "original" ? null : parentLink,
        engagement: engagementCounts(container),
      };
    },
    imageSelector: [
      '[data-testid="tweetPhoto"] img',
      '[data-testid="previewInterstitial"] img[alt="Embedded video"]',
    ].join(","),
    pendingContentPattern: /^(?:new posts?|show(?: \d+)? posts?)$/i,
  });

  function engagementCounts(container) {
    const result = {};
    for (const kind of ["reply", "retweet", "like", "bookmark"]) {
      const value = container.querySelector(`[data-testid="${kind}"]`)?.getAttribute("aria-label") ?? "";
      const count = value.match(/[\d,.]+/)?.[0];
      if (count) result[kind === "retweet" ? "repost" : kind] = count;
    }
    return result;
  }
})();
