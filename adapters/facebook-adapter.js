(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  const candidateSelectors = Object.freeze([
    'div[aria-posinset]',
    '[role="feed"] > div [role="article"]',
    'main [role="feed"] [role="article"]',
    'main [role="article"]',
  ]);
  const postMediaSelector = [
    'a[href*="/photo"] img[src]',
    'a[href*="/videos/"] img[src]',
    'a[href*="/reel/"] img[src]',
    '[data-ad-preview="message"] ~ * img[src]',
    'video',
  ].join(", ");

  registry.register({
    source: "facebook",
    version: "facebook-dom-v2",
    mediaHosts: Object.freeze(["fbcdn.net", "fbsbx.com"]),
    platformIdFromCandidates: (values) => {
      for (const value of Array.isArray(values) ? values : []) {
        const candidate = String(value ?? "");
        const id = candidate.match(/[?&](?:story_fbid|fbid|photo_id)=(\d+)/i)?.[1]
          ?? candidate.match(/\/(?:posts|videos|reel)\/(\d+)/i)?.[1];
        if (id) return `facebook:post:${id}`;
      }
      return null;
    },
    qualityProfile: "social-post-v1",
    qualitySelectors: Object.freeze({
      author: 'h2 a[role="link"], h3 a[role="link"], strong a[role="link"]',
      avatar: 'a[role="link"] img[src]',
      content: '[data-ad-preview="message"], [data-ad-comet-preview="message"], div[dir="auto"]',
      media: postMediaSelector,
      timestamp: 'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/permalink/"]',
    }),
    freshness: Object.freeze({
      version: "facebook-freshness-v1",
      wakeWhenBackground: true,
      settledWakeIsCurrent: true,
      wakeObservationMs: 4_000,
      probeIntervalMs: 250,
      revealSupported: false,
      pendingContentPattern: /^(?:new posts?|see new posts?)$/i,
    }),
    mediaAcquisition: Object.freeze({
      version: "facebook-media-acquisition-v1",
      maxAttempts: 1,
      settleMs: 900,
      quietRecovery: "bounded_dom",
      detectExpectedKinds: (container, helpers) => facebookMediaRoots(container, helpers).map(({ kind }) => kind),
      extractCandidates: (container, helpers) => facebookMediaRoots(container, helpers).flatMap(({ root, kind }) =>
        helpers.collectRootCandidates(root, {
          kind,
          alt: root.getAttribute?.("aria-label") || root.getAttribute?.("alt") || "",
        })),
    }),
    matchesPage: () => ["facebook.com", "www.facebook.com"].includes(window.location.hostname),
    loginRequired: () => /\/login|\/checkpoint/i.test(window.location.pathname) || Boolean(
      document.querySelector('input[name="email"], input[name="pass"], form[action*="login"]'),
    ),
    feedRootPresent: () => Boolean(document.querySelector('div[aria-posinset], main [role="feed"], [role="feed"], main')),
    discoverCandidates: ({ uniqueElements }) => {
      const selectorCounts = Object.fromEntries(candidateSelectors.map((selector) => [
        selector,
        document.querySelectorAll(selector).length,
      ]));
      const candidates = uniqueElements(candidateSelectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)],
      )).filter(isTopLevelFeedPost);
      return {
        candidates,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: 0,
        strategy: candidateSelectors.find((selector) => selectorCounts[selector] > 0) ?? "none",
        selectorCounts,
      };
    },
    findAuthor: (container, { compactText }) => {
      for (const selector of ['h2 a[role="link"]', 'h3 a[role="link"]', 'strong a[role="link"]']) {
        const author = compactText(container.querySelector(selector)?.innerText);
        if (author && !/^(?:Facebook|Sponsored)$/i.test(author)) return author.slice(0, 300);
      }
      return "";
    },
    findAvatar: (container, { normalizeHttpUrl }) => {
      const images = [...container.querySelectorAll('a[role="link"] img[src]')];
      const avatar = images.find((image) => {
        const rect = image.getBoundingClientRect();
        return rect.width >= 28 && rect.width <= 80 && rect.height >= 28 && rect.height <= 80;
      });
      return normalizeHttpUrl(avatar?.currentSrc || avatar?.src);
    },
    contentRootSelector: '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
    contentExpansion: Object.freeze({
      buttonSelector: '[role="button"]',
      restorable: true,
      attempts: 10,
      intervalMs: 40,
    }),
    avatarFallbackSelectors: Object.freeze(['a[role="link"] img[src]']),
    permalinkPatterns: Object.freeze([
      /\/posts\//,
      /\/permalink\//,
      /\/story\.php/,
      /\/photo/,
      /\/videos\//,
      /\/reel\//,
    ]),
    extractText: (container, { compactText, structuredText }) => {
      const read = typeof structuredText === "function" ? structuredText : compactText;
      const explicit = container.querySelector(
        '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
      );
      if (explicit) return stripExpansionControl(read(explicit));
      const meaningful = [...container.querySelectorAll('div[dir="auto"]')]
        .map((element) => stripExpansionControl(read(element)))
        .filter((text) => text.length >= 20 && !isControlText(text));
      return meaningful.sort((left, right) => right.length - left.length)[0] ?? "";
    },
    extractSemantics: (container, { compactText, normalizeHttpUrl }) => {
      const text = compactText(container.innerText);
      const relationshipType = /\bshared a (?:post|memory)\b/i.test(text) ? "repost" : "original";
      const parentPermalink = relationshipType === "repost"
        ? nativePostAnchors(container, normalizeHttpUrl)[1] ?? null
        : null;
      return {
        contentKind: container.querySelector("video") ? "video" : "post",
        relationshipType,
        parentPermalink,
        engagement: engagementCounts(container, compactText),
      };
    },
    extractPresentation: (container, { compactText }) => {
      const lines = String(container.innerText ?? "").split(/\n+/).map(compactText).filter(Boolean);
      const sponsored = lines.some((line) => /^Sponsored$/i.test(line));
      return {
        socialContext: lines.find((line) => /\bshared (?:this|a post)|commented on this$/i.test(line)) ?? "",
        attributionText: sponsored ? "Sponsored" : "",
        timestampText: lines.find((line) => /^\d+\s*(?:m|h|d|w|mo|y)\b/i.test(line)) ?? "",
        timestampAvailability: "unavailable",
        promoted: sponsored,
      };
    },
    findPermalinkDetails: (container, { normalizeHttpUrl }) => {
      const url = nativePostAnchors(container, normalizeHttpUrl)[0] ?? null;
      return url ? { url, source: "direct_anchor" } : null;
    },
    imageSelector: "img[src]",
    shouldSkipImage: (image) => {
      const rect = image.getBoundingClientRect();
      return Boolean(image.closest('a[role="link"]')) && rect.width <= 96 && rect.height <= 96;
    },
  });

  function isTopLevelFeedPost(candidate) {
    const actions = [...candidate.querySelectorAll('[role="button"], button')]
      .map((button) => String(button.getAttribute?.("aria-label") || button.innerText || "").trim())
      .map(facebookActionKind)
      .filter(Boolean);
    if (new Set(actions).size < 2) return false;
    return !candidate.parentElement?.closest?.('[role="article"]');
  }

  function facebookActionKind(label) {
    if (/^(?:Like|React)(?:\b|$)/i.test(label)) return "like";
    if (/^(?:Comment|Leave a comment)(?:\b|$)/i.test(label)) return "comment";
    if (/^(?:Share|Send)(?:\b|$)/i.test(label)) return "share";
    return "";
  }

  function nativePostAnchors(container, normalizeHttpUrl) {
    return [...container.querySelectorAll('a[href]')]
      .map((anchor) => normalizeHttpUrl(anchor.href))
      .filter((href) => href && /\/(?:posts\/|permalink\/|story\.php|photo|videos\/|reel\/)/i.test(href));
  }

  function facebookMediaRoots(container, { excludeRoot, uniqueElements }) {
    return uniqueElements([...container.querySelectorAll(postMediaSelector)])
      .filter((root) => !excludeRoot?.contains?.(root))
      .map((root) => ({ root, kind: root.matches?.("video") ? "video" : "image" }));
  }

  function engagementCounts(container, compactText) {
    const result = {};
    for (const element of container.querySelectorAll('[aria-label], [role="button"]')) {
      const label = compactText(element.getAttribute?.("aria-label") || element.innerText);
      const match = label.match(/([\d,.]+(?:[KMB])?)\s+(reactions?|comments?|shares?)/i);
      if (!match) continue;
      result[match[2].toLowerCase().replace(/s$/, "").replace("reaction", "like")] = match[1];
    }
    return result;
  }

  function stripExpansionControl(value) {
    return String(value ?? "").replace(/(?:\s+|^)(?:See more|See less)$/i, "").trim();
  }

  function isControlText(value) {
    return /^(?:Like|Comment|Share|Send|Sponsored|See more|See less)$/i.test(value);
  }
})();
