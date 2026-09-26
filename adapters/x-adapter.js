(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  // X Articles use a separate read-view/media-link DOM contract from ordinary
  // Tweet photos and link cards. Keep the selectors narrow so article covers
  // are admitted without promoting profile or unrelated link images.
  const xArticleRootSelector = '[data-testid="twitterArticleReadView"]';
  const xArticleMediaSelector = [
    `${xArticleRootSelector} img[src*="pbs.twimg.com/"], ${xArticleRootSelector} img[srcset*="pbs.twimg.com/"], ${xArticleRootSelector} img[data-src*="pbs.twimg.com/"]`,
    'a[href*="/article/"][href*="/media/"] img[src*="pbs.twimg.com/"], a[href*="/article/"][href*="/media/"] img[srcset*="pbs.twimg.com/"], a[href*="/article/"][href*="/media/"] img[data-src*="pbs.twimg.com/"]',
    'a[href*="/article/"] img[src*="pbs.twimg.com/"], a[href*="/article/"] img[srcset*="pbs.twimg.com/"], a[href*="/article/"] img[data-src*="pbs.twimg.com/"]',
  ].join(", ");
  const xArticleMediaRootSelector = [
    xArticleRootSelector,
    'a[href*="/article/"][href*="/media/"]',
    'a[href*="/article/"]',
  ].join(", ");

  function canonicalizeXPermalink(value) {
    try {
      const url = new URL(String(value ?? ""), "https://x.com/");
      if (url.protocol !== "https:" || url.hostname !== "x.com" || url.username || url.password || url.port) {
        return null;
      }
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/);
      if (!match) return null;
      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch {
      return null;
    }
  }

  registry.register({
    source: "x",
    version: "x-dom-v22",
    mediaHosts: Object.freeze(["pbs.twimg.com", "video.twimg.com"]),
    structuredMediaEvidence: Object.freeze({
      payloadField: "xStructuredMediaEvidence",
      runtime: () => globalThis.AkuXMediaEvidenceRuntime,
      persistentAvatarLookupMessage: "AKU_X_AVATAR_EVIDENCE_LOOKUP",
      coverageKey: "xStructuredMediaEvidence",
      label: "X media evidence",
    }),
    canonicalizePermalink: canonicalizeXPermalink,
    platformIdFromCandidates: (values) => {
      for (const value of Array.isArray(values) ? values : []) {
        const statusId = String(value ?? "").match(/\/status\/(\d+)/)?.[1];
        if (statusId) return `x:status:${statusId}`;
      }
      return null;
    },
    qualityProfile: "social-post-v2",
    evidenceProfile: Object.freeze({
      contentFamily: "feed_post",
      modalities: Object.freeze(["text", "image", "video", "attachment", "quoted_post"]),
    }),
    qualitySelectors: Object.freeze({
      author: '[data-testid="User-Name"]',
      avatar: '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]',
      content: '[data-testid="tweetText"], ' + xArticleRootSelector,
      media: '[data-testid="tweetPhoto"], [data-testid="previewInterstitial"], '
        + '[data-testid="videoPlayer"], [data-testid="videoComponent"], '
        + 'a[href*="/status/"][href*="/photo/"], '
        + '[aria-label*="Video" i], a[aria-label][href] img[src*="/card_img/"], '
        + 'a[aria-label][href] [style*="/card_img/"], '
        + xArticleMediaSelector,
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
      allowTrustedUnknownGeometry: true,
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
    loginRequired: () => (
      /^(?:\/login|\/i\/flow\/login|\/i\/flow\/signup)/i.test(window.location.pathname) ||
      Boolean(document.querySelector(
        'input[autocomplete="username"], input[name="password"], [data-testid="LoginForm_Login_Button"]',
      ))
    ),
    feedRootPresent: () => Boolean(document.querySelector("main")),
    assessReadiness: assessXReadiness,
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
    findQuotedRoot: findQuotedPostContainer,
    contentExpansion: Object.freeze({
      buttonSelector: '[data-testid="tweet-text-show-more-link"]',
      restorable: false,
      attempts: 12,
      intervalMs: 40,
    }),
    avatarFallbackSelectors: Object.freeze([
      '[data-testid="Tweet-User-Avatar"] img',
      '[data-testid^="UserAvatar-Container-"] img',
    ]),
    avatarBackgroundSelectors: Object.freeze([
      '[data-testid="Tweet-User-Avatar"]',
      '[data-testid^="UserAvatar-Container-"]',
    ]),
    visualHydration: Object.freeze({
      avatarRootSelector: '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]',
    }),
    mediaRendering: Object.freeze({
      trustedRootSelector: '[data-testid="tweetPhoto"], [data-testid="previewInterstitial"], [data-testid="videoPlayer"], [data-testid="videoComponent"], a[href*="/status/"][href*="/photo/"], [aria-label*="Video" i], a[aria-label][href] img[src*="/card_img/"], ' + xArticleMediaRootSelector,
      videoRootSelector: '[data-testid="previewInterstitial"], [data-testid="videoPlayer"], [data-testid="videoComponent"], [aria-label*="Video" i]',
      embeddedVideoPattern: /embedded video/i,
      trustedVideo: true,
      backgroundGroups: Object.freeze([
        Object.freeze({ selector: '[data-testid="tweetPhoto"] [style*="background-image"]', kind: "image", closestSelector: '[data-testid="tweetPhoto"]', fallbackAlt: "Image" }),
        Object.freeze({ selector: 'a[aria-label][href] [style*="/card_img/"]', kind: "image", closestSelector: 'a[aria-label][href]', fallbackAlt: "Link preview" }),
        Object.freeze({ selector: '[data-testid="videoPlayer"], [data-testid="videoComponent"], [aria-label*="Video" i]', kind: "video", fallbackAlt: "Video preview" }),
      ]),
    }),
    permalinkPatterns: Object.freeze([/\/status\/\d+/]),
    contentRootSelector: '[data-testid="tweetText"], ' + xArticleRootSelector,
    extractText: (container, { compactText, structuredText }) => {
      const read = typeof structuredText === "function" ? structuredText : compactText;
      return read(container.querySelector('[data-testid="tweetText"]'))
        || read(container.querySelector(xArticleRootSelector))
        || read(container);
    },
    extractSemantics: (container, { compactText, normalizeHttpUrl }) => {
      const socialContext = compactText(
        container.querySelector('[data-testid="socialContext"]')?.innerText,
      );
      const quoted = findQuotedPostContainer(container);
      const reply = replyEvidence(container, compactText);
      const relationshipType = quoted ? "quote" : socialContext ? "repost" : reply ? "reply" : "original";
      const parentLink = quoted ? ownPostURL(quoted) : reply?.permalink || null;
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
    extractPresentation: (container) => ({
      originSignals: registry.extractOriginSignals(container, {
        source: "x",
        definitions: [{
          kind: "platform_ai_label",
          scope: "attached_media",
          labels: ["Made with AI", "AI-generated"],
        }],
      }),
    }),
    extractDirectContext: extractXDirectContext,
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
      const time = quoted.querySelector("time");
      const permalink = canonicalizeXPermalink(
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
        links: [...(textRoot?.querySelectorAll("a[href]") ?? [])]
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
      xArticleMediaSelector,
    ].join(","),
  });

  function assessXReadiness(context) {
    if (context.state === "selector_mismatch" &&
        context.feedRootPresent === true &&
        context.documentReadyState === "complete" &&
        context.structuralCandidateCount === 0) {
      return {
        state: "selector_mismatch",
        diagnosis: "feed_shell_unhydrated",
        recovery: {
          action: "recreate_managed_surface",
          reason: "feed_shell_unhydrated",
          maxAttempts: 1,
        },
      };
    }
    return {
      state: context.state,
      diagnosis: context.state === "loading" ? "navigation_incomplete" : "readiness_observed",
    };
  }

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
      ...container.querySelectorAll(xArticleMediaSelector),
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


  function ownPostURL(container) {
    const quote = findQuotedPostContainer(container);
    const times = [...(container.querySelectorAll?.("time") ?? [])];
    const urls = times.filter((time) => !quote?.contains?.(time))
      .map((time) => canonicalizeXPermalink(time.closest?.("a[href]")?.href)).filter(Boolean);
    return [...new Set(urls)].length === 1 ? urls[0] : null;
  }

  function statusID(url) { return String(url || "").match(/\/status\/(\d+)/)?.[1] || ""; }

  // Reply target identity must be explicit. Account mentions and card adjacency
  // cannot identify the replied-to post.
  function replyEvidence(container, compactText) {
    const ownID = statusID(ownPostURL(container));
    const observedID = globalThis.AkuXMediaEvidenceRuntime?.lookupReplyTo?.(`x:status:${ownID}`);
    if (observedID && observedID !== ownID) return {
      permalink: `https://x.com/i/status/${observedID}`, provenance: "observed_response", text: "",
    };
    const quote = findQuotedPostContainer(container);
    const markers = [...(container.querySelectorAll?.('[data-testid="replyingTo"], [data-testid="replying-to"], div[dir="ltr"]') ?? [])]
      .filter((node) => !quote?.contains?.(node)
        && !node.closest?.('[data-testid="tweetText"], [data-testid="User-Name"]')
        && !node.querySelector?.('[data-testid="tweetText"]')
        && /^(?:Replying to|Membalas)\b/i.test(compactText(node.innerText))
        && compactText(node.innerText).length <= 300);
    if (!markers.length) return null;
    const urls = [...new Set(markers.flatMap((node) => [...node.querySelectorAll('a[href*="/status/"]')])
      .map((node) => canonicalizeXPermalink(node.href)).filter((url) => url && statusID(url) !== ownID))];
    return { permalink: urls.length === 1 ? urls[0] : "", provenance: "observed_dom", text: compactText(markers[0].innerText) };
  }

  function extractXDirectContext(container, { compactText, structuredText, permalink, quotedPost }) {
    const capturedAt = new Date().toISOString();
    const relations = [];
    const ownID = statusID(permalink);
    if (quotedPost && (!quotedPost.permalink || statusID(quotedPost.permalink) !== ownID)) {
      relations.push({ kind: "quotes", provenance: "observed_dom", capturedAt,
        target: { kind: "post", id: statusID(quotedPost.permalink), permalink: quotedPost.permalink || "",
          author: quotedPost.author || "", text: quotedPost.text || "", hasMedia: Boolean(quotedPost.media?.length),
          availability: quotedPost.text || quotedPost.media?.length ? "captured" : "reference_only" } });
    }
    const reply = replyEvidence(container, compactText);
    if (reply) {
      const id = statusID(reply.permalink);
      if (id && id === ownID) return relations;
      const candidates = id ? [...(document.querySelectorAll?.('article[data-testid="tweet"]') ?? [])]
        .filter((node) => node !== container && (!node.getClientRects || node.getClientRects().length > 0) && statusID(ownPostURL(node)) === id) : [];
      const parent = candidates.length === 1 ? candidates[0] : null;
      const textNode = parent?.querySelector('[data-testid="tweetText"]');
      const text = textNode ? (structuredText?.(textNode) || compactText(textNode.innerText)).slice(0, 4000) : "";
      relations.push({ kind: "replies_to", provenance: reply.provenance, capturedAt, observedText: reply.text,
        target: { kind: "post", id, permalink: reply.permalink, text,
          author: compactText(parent?.querySelector('[data-testid="User-Name"]')?.innerText).slice(0, 300),
          availability: text ? "captured" : "reference_only" } });
    }
    return relations;
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
