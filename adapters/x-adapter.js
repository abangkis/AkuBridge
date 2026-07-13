(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  registry.register({
    source: "x",
    version: "x-dom-v12",
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
      const selectors = [
        '[data-testid="Tweet-User-Avatar"] img',
        '[data-testid^="UserAvatar-Container-"] img',
      ];
      for (const selector of selectors) {
        const image = container.querySelector(selector);
        const url = imageUrls(image).map(normalizeHttpUrl).find(Boolean);
        if (url) return url;
      }
      return null;
    },
    contentRootSelector: '[data-testid="tweetText"]',
    extractText: (container, { compactText, structuredText }) => {
      const read = typeof structuredText === "function" ? structuredText : compactText;
      return read(container.querySelector('[data-testid="tweetText"]')) || read(container);
    },
    extractSemantics: (container, { compactText, normalizeHttpUrl }) => {
      const socialContext = compactText(
        container.querySelector('[data-testid="socialContext"]')?.innerText,
      );
      const quoted = findQuotedPostContainer(container);
      const reply = compactText(container.innerText).match(/^Replying to\b/i);
      const relationshipType = quoted ? "quote" : socialContext ? "repost" : reply ? "reply" : "original";
      const relationshipContainer = quoted || container;
      const parentLink = [...relationshipContainer.querySelectorAll('a[href*="/status/"]')]
        .map((anchor) => normalizeHttpUrl(anchor.href))
        .find(Boolean) ?? null;
      const ownVideo = [...container.querySelectorAll(
        'video, [data-testid="previewInterstitial"], [data-testid="videoPlayer"], '
          + '[data-testid="videoComponent"], [aria-label*="Video" i]',
      )].some((element) => !quoted?.contains?.(element));
      return {
        contentKind: ownVideo ? "video" : "post",
        relationshipType,
        parentPermalink: relationshipType === "original" ? null : parentLink,
        engagement: engagementCounts(container),
      };
    },
    extractQuotedPost: (container, {
      compactText,
      normalizeHttpUrl,
      structuredText,
      findMedia,
    }) => {
      const quoted = findQuotedPostContainer(container);
      if (!quoted) return null;
      const textRoot = quoted.querySelector('[data-testid="tweetText"]');
      const text = typeof structuredText === "function"
        ? structuredText(textRoot)
        : compactText(textRoot?.innerText);
      if (!text) return null;
      const time = quoted.querySelector("time");
      const permalink = normalizeHttpUrl(
        time?.closest?.("a[href]")?.href ||
        [...quoted.querySelectorAll('a[href*="/status/"]')][0]?.href,
      );
      const avatar = quoted.querySelector('[data-testid^="UserAvatar-Container-"] img');
      return {
        author: compactText(quoted.querySelector('[data-testid="User-Name"]')?.innerText),
        avatarUrl: imageUrls(avatar).map(normalizeHttpUrl).find(Boolean) ?? null,
        text,
        permalink,
        publishedAt: time?.getAttribute?.("datetime") || null,
        links: [...textRoot.querySelectorAll("a[href]")]
          .map((anchor) => ({
            text: compactText(anchor.innerText).slice(0, 300),
            href: normalizeHttpUrl(anchor.href),
          }))
          .filter((link) => link.href)
          .slice(0, 10),
        media: typeof findMedia === "function" ? findMedia(quoted) : [],
      };
    },
    imageSelector: [
      '[data-testid="tweetPhoto"] img',
      '[data-testid="previewInterstitial"] img[alt="Embedded video"]',
      '[data-testid="videoPlayer"] img',
      '[data-testid="videoComponent"] img',
      'a[aria-label][href] img[src*="/card_img/"]',
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

function imageUrls(image) {
  if (!image) return [];
  const srcsets = [image.srcset, image.getAttribute?.("srcset")].filter(Boolean);
  const srcsetUrls = srcsets.flatMap((srcset) => String(srcset).split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean));
  return [...new Set([
    image.currentSrc,
    image.src,
    image.getAttribute?.("src"),
    ...srcsetUrls,
  ].filter(Boolean))];
}

  function findQuotedPostContainer(container) {
    const explicit = container.querySelector('[data-testid="quoteTweet"]');
    if (explicit) return explicit;
    const textRoots = [...container.querySelectorAll('[data-testid="tweetText"]')];
    for (const textRoot of textRoots.slice(1)) {
      const quoted = textRoot.closest?.('[role="link"]');
      if (quoted && quoted !== container) return quoted;
    }
    return null;
  }
})();
