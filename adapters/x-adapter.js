(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");
  const capturePrimitives = globalThis.AkuCapturePrimitives;
  if (!capturePrimitives) throw new Error("AkuBridge capture primitives were not loaded.");

  // X Articles use a separate read-view/media-link DOM contract from ordinary
  // Tweet photos and link cards. Keep the selectors narrow so article covers
  // are admitted without promoting profile or unrelated link images.
  const xArticleRootSelector = '[data-testid="twitterArticleReadView"]';
  const legacyAuthorSelector = '[data-testid="User-Name"]';
  const legacyTextSelector = '[data-testid="tweetText"]';
  const wrappedPostPermalink = capturePrimitives.xWrappedPostPermalink;
  const wrappedTextSelector = 'div[dir="auto"].whitespace-pre-wrap';
  const wrappedAuthorSelector = '.x-middot-group a[href]';
  const wrappedAvatarSelector = 'img[src^="https://pbs.twimg.com/profile_images/"]';
  const wrappedPhotoSelector = 'img[src^="https://pbs.twimg.com/media/"]';
  const wrappedVideoPosterSelector = ["ext_tw_video_thumb", "amplify_video_thumb", "tweet_video_thumb"]
    .map((path) => `img[src^="https://pbs.twimg.com/${path}/"]`).join(", ");
  const xContentRootSelector = [legacyTextSelector, xArticleRootSelector, wrappedTextSelector].join(", ");
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
    return capturePrimitives.canonicalizeXPermalink(value);
  }

  function matchesFreshnessFeedURL(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "x.com" &&
        !url.username && !url.password && !url.port && url.pathname === "/home";
    } catch { return false; }
  }

  function freshnessPrimaryIdentity(post) {
    if (typeof post?.id !== "string" || typeof post?.permalink !== "string") return null;
    const id = /^(?:x:status:)?(\d{1,30})$/.exec(post.id)?.[1];
    const permalink = canonicalizeXPermalink(post.permalink);
    if (!id || !permalink || new URL(permalink).pathname.match(/\/status\/(\d+)$/)?.[1] !== id) return null;
    return { id, permalink };
  }

  registry.register({
    source: "x",
    version: "x-dom-v25",
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
      author: [legacyAuthorSelector, wrappedAuthorSelector].join(", "),
      avatar: '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"], ' + wrappedAvatarSelector,
      content: xContentRootSelector,
      media: '[data-testid="tweetPhoto"], [data-testid="previewInterstitial"], '
        + '[data-testid="videoPlayer"], [data-testid="videoComponent"], '
        + 'a[href*="/status/"][href*="/photo/"], '
        + '[aria-label*="Video" i], a[aria-label][href] img[src*="/card_img/"], '
        + 'a[aria-label][href] [style*="/card_img/"], '
        + [xArticleMediaSelector, wrappedPhotoSelector, wrappedVideoPosterSelector, "video"].join(", "),
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
      // X also labels its composer "New Post". Match feed controls only.
      pendingContentPattern: /^(?:new posts|show(?: \d+)? posts?)$/i,
      headless: Object.freeze({
        enabled: true,
        version: "x-headless-freshness-v1",
        matchesFeedURL: matchesFreshnessFeedURL,
        primaryIdentity: freshnessPrimaryIdentity,
      }),
    }),
    mediaAcquisition: Object.freeze({
      version: "x-media-acquisition-v2",
      maxAttempts: 1,
      settleMs: 700,
      quietRecovery: "bounded_dom",
      foregroundAfterQuietExhaustion: true,
      allowTrustedUnknownGeometry: true,
      detectExpectedKinds: detectXExpectedMediaKinds,
      extractStructuredCandidates: (container, { candidateId, excludeRoot } = {}) => {
        const runtime = globalThis.AkuXMediaEvidenceRuntime;
        const identity = resolveIdentity(container, excludeRoot);
        const id = identity?.permalink ? `x:status:${statusID(identity.permalink)}` : null;
        if (identity && (!id || candidateId && candidateId !== id)) return [];
        const candidates = id ? runtime?.lookup?.(id) : runtime?.lookupContainer?.(container);
        return (candidates ?? []).filter((entry) => entry.kind !== "avatar").map((entry) => ({
          ...entry,
          trustedMediaRoot: true,
          urlSource: entry.provenance ?? "x_structured_state",
        }));
      },
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
    captureReadinessRejections: xCaptureReadinessRejections,
    discoverCandidates: ({ uniqueElements }) => {
      const primary = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const fallback = [...document.querySelectorAll("main article")];
      const candidates = uniqueElements([...primary, ...fallback]).filter((article) =>
        !wrappedPostPermalink(article) || !article.parentElement?.closest?.("article"));
      return {
        candidates,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: 0,
        strategy: primary.length > 0 ? "tweet_testid" : fallback.length > 0 ? "main_article" : "none",
        selectorCounts: { tweet_testid: primary.length, main_article: fallback.length },
      };
    },
    findAuthor: findXAuthor,
    resolveIdentity,
    findPermalinkDetails: (container) => {
      const url = wrappedPostPermalink(container);
      return url ? { url, source: "post_wrapper" } : null;
    },
    findAvatar: (container, { normalizeHttpUrl }) => {
      const wrapped = wrappedPostPermalink(container);
      const selectors = [
        '[data-testid="Tweet-User-Avatar"] img',
        '[data-testid^="UserAvatar-Container-"] img',
      ];
      for (const selector of selectors) {
        const image = wrapped ? firstOwnElement(container, selector) : container.querySelector(selector);
        const url = imageUrls(image).map(normalizeHttpUrl).find(Boolean);
        if (url) return url;
      }
      const avatar = wrapped && firstOwnElement(container, wrappedAvatarSelector);
      const avatarUrl = imageUrls(avatar).map(normalizeHttpUrl).find(Boolean);
      if (avatarUrl) return avatarUrl;
      const runtime = globalThis.AkuXMediaEvidenceRuntime;
      return normalizeHttpUrl(wrapped ? runtime?.lookupAvatar?.(`x:status:${statusID(wrapped)}`)
        : runtime?.lookupAvatarContainer?.(container));
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
      avatarRootSelector: '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"], ' + wrappedAvatarSelector,
    }),
    mediaRendering: Object.freeze({
      trustedRootSelector: '[data-testid="tweetPhoto"], [data-testid="previewInterstitial"], [data-testid="videoPlayer"], [data-testid="videoComponent"], a[href*="/status/"][href*="/photo/"], [aria-label*="Video" i], a[aria-label][href] img[src*="/card_img/"], ' + [xArticleMediaRootSelector, wrappedPhotoSelector, wrappedVideoPosterSelector].join(", "),
      videoRootSelector: '[data-testid="previewInterstitial"], [data-testid="videoPlayer"], [data-testid="videoComponent"], [aria-label*="Video" i], ' + wrappedVideoPosterSelector,
      embeddedVideoPattern: /embedded video/i,
      trustedVideo: true,
      backgroundGroups: Object.freeze([
        Object.freeze({ selector: '[data-testid="tweetPhoto"] [style*="background-image"]', kind: "image", closestSelector: '[data-testid="tweetPhoto"]', fallbackAlt: "Image" }),
        Object.freeze({ selector: 'a[aria-label][href] [style*="/card_img/"]', kind: "image", closestSelector: 'a[aria-label][href]', fallbackAlt: "Link preview" }),
        Object.freeze({ selector: '[data-testid="videoPlayer"], [data-testid="videoComponent"], [aria-label*="Video" i]', kind: "video", fallbackAlt: "Video preview" }),
      ]),
    }),
    permalinkPatterns: Object.freeze([/\/status\/\d+/]),
    contentRootSelector: xContentRootSelector,
    resolveContentRoot: findXTextRoot,
    extractText: (container, { compactText, structuredText }) => {
      const read = (node) => typeof structuredText === "function"
        ? structuredText(node)
        : compactText(node?.innerText ?? node?.textContent);
      if (!container) return "";
      if (isXTextRoot(container)) return read(container);

      const root = findXTextRoot(container);
      return root ? read(root) : "";
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
      const wrapped = wrappedPostPermalink(quoted);
      const textRoot = wrapped ? findXTextRoot(quoted) : quoted.querySelector(legacyTextSelector);
      const text = typeof structuredText === "function"
        ? structuredText(textRoot)
        : compactText(textRoot?.innerText);
      const time = quoted.querySelector("time");
      const quoteIdentity = resolveIdentity(quoted, undefined, true);
      const primaryIdentity = quoteIdentity?.permalink ? resolveIdentity(container, quoted) : null;
      const identityConflictReason = quoteIdentity?.status === "conflicting" ? "dom_identity_conflict"
        : quoteIdentity?.permalink && statusID(quoteIdentity.permalink) === statusID(primaryIdentity?.permalink)
          ? "primary_self_reference" : null;
      const permalink = quoteIdentity ? (identityConflictReason ? null : quoteIdentity.permalink) : wrapped ?? canonicalizeXPermalink(
        time?.closest?.("a[href]")?.href ||
        [...quoted.querySelectorAll('a[href*="/status/"]')][0]?.href,
      );
      const avatar = quoted.querySelector('[data-testid^="UserAvatar-Container-"] img') ??
        (wrapped ? firstOwnElement(quoted, wrappedAvatarSelector) : null);
      return {
        author: wrapped ? findXAuthor(quoted, { compactText })
          : compactText(quoted.querySelector(legacyAuthorSelector)?.innerText),
        avatarUrl: imageUrls(avatar).map(normalizeHttpUrl).find(Boolean) ?? null,
        text,
        permalink,
        ...(identityConflictReason ? { identityConflictReason } : {}),
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
      wrappedPhotoSelector,
      wrappedVideoPosterSelector,
    ].join(","),
  });

  function xCaptureReadinessRejections(container, { compactText, uniqueElements }) {
    const quote = findQuotedPostContainer(container);
    const hasAuthor = Boolean(findXAuthor(container, { compactText }, quote));
    const identity = resolveIdentity(container, quote);
    if (compactText(findXTextRoot(container, quote)?.innerText)) {
      if (identity && identity.status !== "identified") {
        return { missingAuthor: !hasAuthor, missingPermalink: true };
      }
      return hasAuthor ? null : { missingAuthor: true };
    }
    const hasPermalink = Boolean(identity ? identity.permalink : ownPostURL(container, quote));
    const quoteIdentity = quote && resolveIdentity(quote, undefined, true);
    const quotePermalink = quoteIdentity ? quoteIdentity.permalink : quote && ownPostURL(quote);
    const hasQuote = Boolean(quote && ((!identity && !wrappedPostPermalink(container)) ||
      (quotePermalink && statusID(quotePermalink) !== statusID(identity?.permalink) && findXAuthor(quote, { compactText }) &&
        (compactText(findXTextRoot(quote)?.innerText) ||
          detectXExpectedMediaKinds(quote, { uniqueElements }).length > 0))));
    const hasMediaOrQuote = hasQuote ||
      detectXExpectedMediaKinds(container, { excludeRoot: quote, uniqueElements }).length > 0;
    if (hasPermalink && hasMediaOrQuote) return hasAuthor ? null : { missingAuthor: true };
    return {
      missingAuthor: !hasAuthor,
      missingText: true,
      missingMediaOrQuote: !hasMediaOrQuote,
      missingPermalink: !hasPermalink,
    };
  }

  function assessXReadiness(context) {
    if (context.state === "feed_empty" && context.visibleStructuralCandidateCount > 0) {
      return { state: "feed_hydrating", diagnosis: "post_evidence_unhydrated" };
    }
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
      ...(wrappedPostPermalink(container) ? ["video", wrappedVideoPosterSelector] : []),
    ].join(",");
    const roots = uniqueElements([
      ...container.querySelectorAll('[data-testid="tweetPhoto"]'),
      ...container.querySelectorAll('a[href*="/status/"][href*="/photo/"]'),
      ...container.querySelectorAll(videoSelector),
      ...container.querySelectorAll('a[aria-label][href] img, a[aria-label][href] [style*="/card_img/"]'),
      ...container.querySelectorAll(xArticleMediaSelector),
      ...(wrappedPostPermalink(container) ? container.querySelectorAll(wrappedPhotoSelector) : []),
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


  function resolveIdentity(container, excludeRoot = findQuotedPostContainer(container), allowQuoteAnchors = false) {
    return globalThis.AkuXDOMShadow?.resolveIdentity?.(container, registry.get("x"), excludeRoot, allowQuoteAnchors);
  }

  function ownPostURL(container, quote = findQuotedPostContainer(container)) {
    const shared = resolveIdentity(container, quote);
    if (shared) return shared.permalink;
    const wrapped = wrappedPostPermalink(container);
    if (wrapped) return wrapped;
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
    const nestedPost = [...(container.querySelectorAll?.("article") ?? [])]
      .find((article) => wrappedPostPermalink(article));
    if (nestedPost) return nestedPost;
    const textRoots = [...container.querySelectorAll('[data-testid="tweetText"]')];
    for (const textRoot of textRoots) {
      const quoted = textRoot.closest?.('[role="link"]');
      if (quoted && quoted !== container && container.contains(quoted)) return quoted;
    }
    return null;
  }

  function firstOwnElement(container, selector, quote = findQuotedPostContainer(container)) {
    return [...container.querySelectorAll(selector)].find((element) => !quote?.contains?.(element));
  }

  function findXTextRoot(container, quote = findQuotedPostContainer(container)) {
    return firstOwnElement(container, legacyTextSelector, quote) ??
      firstOwnElement(container, xArticleRootSelector, quote) ??
      (wrappedPostPermalink(container) ? firstOwnElement(container, wrappedTextSelector, quote) : null);
  }

  function findXAuthor(container, { compactText }, quote = findQuotedPostContainer(container)) {
    const legacy = compactText(firstOwnElement(container, legacyAuthorSelector, quote)?.innerText);
    if (legacy) return legacy.slice(0, 300);
    const permalink = wrappedPostPermalink(container);
    const handle = permalink && new URL(permalink).pathname.split("/")[1].toLowerCase();
    if (!handle || handle === "i") return "";
    const profile = `https://x.com/${handle}`;
    const body = findXTextRoot(container, quote);
    const profileNames = (selector) => [...container.querySelectorAll(selector)]
      .filter((anchor) => !quote?.contains?.(anchor) && !body?.contains?.(anchor) &&
        anchor.href?.replace(/\/$/, "").toLowerCase() === profile)
      .map((anchor) => compactText(anchor.innerText)).filter(Boolean);
    const headerNames = profileNames(wrappedAuthorSelector);
    const names = headerNames.length ? headerNames : profileNames("a[href]");
    return (names.find((name) => !name.startsWith("@")) ?? names[0] ?? "").slice(0, 300);
  }

  function isXTextRoot(element) {
    const testId = element.getAttribute?.("data-testid");
    return testId === "tweetText" || testId === "twitterArticleReadView" ||
      Boolean(element.matches?.(xContentRootSelector));
  }
})();
