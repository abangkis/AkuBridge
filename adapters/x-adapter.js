(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  registry.register({
    source: "x",
    version: "x-dom-v19",
    qualityProfile: "social-post-v1",
    qualitySelectors: Object.freeze({
      author: '[data-testid="User-Name"]',
      avatar: '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]',
      content: '[data-testid="tweetText"]',
      media: '[data-testid="tweetPhoto"], [data-testid="previewInterstitial"], '
        + '[data-testid="videoPlayer"], [data-testid="videoComponent"], '
        + 'a[href*="/status/"][href*="/photo/"], '
        + '[aria-label*="Video" i], a[aria-label][href] img[src*="/card_img/"], '
        + 'a[aria-label][href] [style*="/card_img/"]',
      timestamp: "time",
    }),
    freshness: Object.freeze({
      version: "x-freshness-v1",
      wakeWhenBackground: true,
      settledWakeIsCurrent: true,
      wakeObservationMs: 3_500,
      probeIntervalMs: 250,
      revealSupported: true,
      revealObservationMs: 5_000,
      rejectInsideFeedCandidate: true,
      pendingContentPattern: /^(?:new posts?|show(?: \d+)? posts?)$/i,
    }),
    mediaAcquisition: Object.freeze({
      version: "x-media-acquisition-v2",
      maxAttempts: 1,
      settleMs: 700,
      quietRecovery: "bounded_dom",
      foregroundAfterQuietExhaustion: true,
      detectExpectedKinds: detectXExpectedMediaKinds,
      extractStructuredCandidates: (container) => (
        globalThis.AkuXMediaEvidenceRuntime?.lookupContainer?.(container) ?? []
      ).filter((entry) => entry.kind !== "avatar").map((entry) => ({
        ...entry,
        trustedMediaRoot: true,
        urlSource: entry.provenance ?? "x_structured_state",
      })),
      extractCandidates: extractXRecoveryCandidates,
    }),
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
      return normalizeHttpUrl(
        globalThis.AkuXMediaEvidenceRuntime?.lookupAvatarContainer?.(container),
      );
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
      'a[href*="/status/"][href*="/photo/"] img',
      '[data-testid="previewInterstitial"] img[alt="Embedded video"]',
      '[data-testid="videoPlayer"] img',
      '[data-testid="videoComponent"] img',
      'a[aria-label][href] img[src*="/card_img/"]',
    ].join(","),
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

  function extractXRecoveryCandidates(container, {
    excludeRoot,
    collectRootCandidates,
    uniqueElements,
  }) {
    return xMediaRoots(container, { excludeRoot, uniqueElements }).flatMap(({ root, kind }) =>
      collectRootCandidates(root, {
        kind,
        alt: root.getAttribute?.("aria-label") ||
          root.closest?.('a[aria-label]')?.getAttribute?.("aria-label") || "",
      }));
  }

  function detectXExpectedMediaKinds(container, { excludeRoot, uniqueElements }) {
    return xMediaRoots(container, { excludeRoot, uniqueElements }).map(({ kind }) => kind);
  }

  function xMediaRoots(container, { excludeRoot, uniqueElements }) {
    const videoSelector = [
      '[data-testid="previewInterstitial"]',
      '[data-testid="videoPlayer"]',
      '[data-testid="videoComponent"]',
      '[aria-label*="Video" i]',
    ].join(",");
    const roots = uniqueElements([
      ...container.querySelectorAll('[data-testid="tweetPhoto"]'),
      ...container.querySelectorAll('a[href*="/status/"][href*="/photo/"]'),
      ...container.querySelectorAll(videoSelector),
      ...container.querySelectorAll('a[aria-label][href] img, a[aria-label][href] [style*="/card_img/"]'),
    ]).filter((root) => !excludeRoot?.contains?.(root));
    return roots.map((root) => {
      const videoRoot = root.matches?.(videoSelector) || root.closest?.(videoSelector);
      return { root, kind: videoRoot ? "video" : "image" };
    });
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
