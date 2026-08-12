(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  const nativePostPattern = /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/;
  const reservedProfilePaths = new Set([
    "accounts",
    "direct",
    "explore",
    "reels",
    "stories",
    "legal",
    "about",
  ]);
  const mediaEvidenceRuntime = globalThis.AkuMediaPostProcessor?.createEvidenceRuntime?.({
    source: "instagram",
    candidateIdFromContainer: instagramCandidateIdFromContainer,
    normalizeCandidateId: normalizeInstagramMediaCandidateId,
    normalizeMedia: normalizeInstagramStructuredMedia,
    ttlMs: 15 * 60 * 1_000,
  }) ?? null;

  registry.register({
    source: "instagram",
    version: "instagram-dom-v3",
    mediaHosts: Object.freeze(["fbcdn.net", "cdninstagram.com"]),
    structuredMediaEvidence: Object.freeze({
      payloadField: "instagramStructuredMediaEvidence",
      runtime: () => mediaEvidenceRuntime,
      coverageKey: "instagramStructuredMediaEvidence",
      label: "Instagram media evidence",
    }),
    platformIdFromCandidates: instagramPlatformIdFromCandidates,
    qualityProfile: "social-post-v2",
    evidenceProfile: Object.freeze({
      contentFamily: "feed_post",
      modalities: Object.freeze(["text", "image", "video", "attachment", "quoted_post"]),
    }),
    qualitySelectors: Object.freeze({
      author: 'a[href^="/"] img[alt*="profile picture" i], a[href^="/"]',
      avatar: 'a[href^="/"] img[alt*="profile picture" i]',
      content: 'span[dir="auto"]',
      media: 'video, img:not([alt*="profile picture" i])',
      timestamp: "time",
    }),
    freshness: Object.freeze({
      version: "instagram-freshness-v1",
      wakeWhenBackground: true,
      settledWakeIsCurrent: true,
      wakeObservationMs: 3_500,
      probeIntervalMs: 250,
      revealSupported: false,
      pendingContentPattern: /^(?:new posts?|see new posts?)$/i,
    }),
    mediaAcquisition: Object.freeze({
      version: "instagram-media-acquisition-v2",
      maxAttempts: 1,
      settleMs: 800,
      quietRecovery: "bounded_dom",
      detectExpectedKinds: (container, helpers) => instagramMediaRoots(container, helpers)
        .map(({ kind }) => kind),
      extractStructuredCandidates: (container) => (
        mediaEvidenceRuntime?.lookupContainer?.(container) ?? []
      ).map((entry) => ({
        ...entry,
        trustedMediaRoot: true,
        urlSource: entry.provenance ?? "instagram_structured_json",
      })),
      extractCandidates: (container, helpers) => instagramMediaRoots(container, helpers)
        .flatMap(({ root, kind }) => helpers.collectRootCandidates(root, {
          kind,
          alt: root.getAttribute?.("aria-label") || root.getAttribute?.("alt") || "",
        })),
    }),
    captureTuning: Object.freeze({
      scrollStepMultiplier: 1,
      scrollStrategy: "next_candidate",
    }),
    matchesPage: () => ["instagram.com", "www.instagram.com"].includes(window.location.hostname),
    loginRequired: () => /\/accounts\/login/i.test(window.location.pathname) || Boolean(
      document.querySelector('input[name="username"], input[name="password"]'),
    ),
    feedRootPresent: () => Boolean(document.querySelector("main")),
    assessReadiness: assessInstagramReadiness,
    discoverCandidates: ({ uniqueElements }) => {
      const structural = uniqueElements([...document.querySelectorAll("main article")]);
      const candidates = structural.filter((candidate) => Boolean(instagramPermalink(candidate)));
      return {
        candidates,
        readinessCandidates: structural,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: 0,
        strategy: candidates.length > 0 ? "main_article_native_permalink" : structural.length > 0
          ? "main_article_unresolved"
          : "none",
        selectorCounts: { main_article: structural.length, native_permalink: candidates.length },
      };
    },
    findAuthor: instagramAuthor,
    findAvatar: (container, { normalizeHttpUrl }) => {
      for (const anchor of instagramProfileAnchors(container)) {
        const image = anchor.querySelector?.('img[alt*="profile picture" i]');
        const url = normalizeHttpUrl(image?.currentSrc || image?.src || image?.getAttribute?.("src"));
        if (url) return url;
      }
      return null;
    },
    contentExpansion: Object.freeze({
      buttonSelector: '[role="button"], button',
      restorable: false,
      attempts: 12,
      intervalMs: 40,
    }),
    avatarFallbackSelectors: Object.freeze([
      'a[href^="/"] img[alt*="profile picture" i]',
    ]),
    mediaRendering: Object.freeze({
      trustedRootSelector: 'video, img:not([alt*="profile picture" i])',
      videoRootSelector: "video",
      trustedVideo: true,
    }),
    permalinkPatterns: Object.freeze([
      /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/,
    ]),
    findPermalinkDetails: (container, { normalizeHttpUrl }) => {
      const url = normalizeHttpUrl(instagramPermalink(container));
      return url ? { url, source: "native_post_anchor" } : null;
    },
    extractText: (container, { compactText }) => instagramCaption(container, compactText),
    extractSemantics: (container, { compactText }) => ({
      contentKind: container.querySelector("video") ? "video" : "post",
      relationshipType: "original",
      parentPermalink: null,
      engagement: instagramEngagement(container, compactText),
    }),
    extractPresentation: (container, { compactText }) => ({
      promoted: /(?:^|\n)Sponsored(?:\n|$)/i.test(String(container.innerText ?? "")),
      timestampText: compactText(container.querySelector("time")?.textContent),
      timestampAvailability: container.querySelector("time") ? "native_datetime" : "unavailable",
      originSignals: registry.extractOriginSignals(container, {
        source: "instagram",
        definitions: [{
          kind: "platform_ai_label",
          scope: "attached_media",
          labels: ["AI info", "Made with AI"],
        }],
      }),
    }),
    imageSelector: 'img:not([alt*="profile picture" i])',
    shouldSkipImage: (image) => {
      if (/profile picture/i.test(image.getAttribute?.("alt") || "")) return true;
      const rect = image.getBoundingClientRect?.() ?? {};
      const width = rect.width || image.naturalWidth || 0;
      const height = rect.height || image.naturalHeight || 0;
      return width > 0 && height > 0 && (width < 180 || height < 90);
    },
  });

  function assessInstagramReadiness(context) {
    if (context.feedRootPresent === true &&
        context.documentReadyState === "complete" &&
        context.selectorCandidateCount === 0) {
      const structuralPostsPresent = context.structuralCandidateCount > 0;
      return {
        state: structuralPostsPresent ? "feed_hydrating" : "selector_mismatch",
        diagnosis: structuralPostsPresent
          ? "post_permalink_unhydrated"
          : "feed_shell_unhydrated",
        recovery: {
          action: "recreate_managed_surface",
          reason: structuralPostsPresent
            ? "post_permalink_unhydrated"
            : "feed_shell_unhydrated",
          maxAttempts: 1,
        },
      };
    }
    return {
      state: context.state,
      diagnosis: context.state === "loading" ? "navigation_incomplete" : "readiness_observed",
    };
  }

  function instagramPlatformIdFromCandidates(values) {
    for (const value of Array.isArray(values) ? values : []) {
      const match = String(value ?? "").match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/i);
      if (!match) continue;
      return `instagram:${match[1].toLowerCase()}:${match[2]}`;
    }
    return null;
  }

  function instagramCandidateIdFromContainer(container) {
    return instagramPlatformIdFromCandidates([instagramPermalink(container)]);
  }

  function normalizeInstagramMediaCandidateId(value) {
    if (typeof value !== "string") return null;
    const direct = value.trim().match(/^instagram:(?:post|p|reel|tv):([A-Za-z0-9_-]+)$/i);
    if (direct) return `instagram:post:${direct[1]}`;
    const platformId = instagramPlatformIdFromCandidates([value]);
    const shortcode = platformId?.match(/^instagram:(?:p|reel|tv):([A-Za-z0-9_-]+)$/i)?.[1];
    return shortcode ? `instagram:post:${shortcode}` : null;
  }

  function normalizeInstagramStructuredMedia(value) {
    if (!value || value.kind !== "video") return null;
    const posterUrl = safeInstagramMediaUrl(value.posterUrl || value.url, "image");
    const playbackUrl = safeInstagramMediaUrl(value.playbackUrl, "video");
    if (!posterUrl || !playbackUrl) return null;
    return Object.freeze({
      kind: "video",
      url: posterUrl,
      posterUrl,
      playbackUrl,
      playbackMode: "inline",
      width: positiveMediaDimension(value.width),
      height: positiveMediaDimension(value.height),
      provenance: String(value.provenance || "instagram_structured_json").slice(0, 60),
    });
  }

  function safeInstagramMediaUrl(value, kind) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" || url.username || url.password || url.port ||
        !["fbcdn.net", "cdninstagram.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
      ) return null;
      if (kind === "video" && !/\.mp4$/i.test(url.pathname)) return null;
      if (kind === "image" && !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname)) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function positiveMediaDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(8_192, Math.round(number)) : 0;
  }

  function instagramPermalink(container) {
    for (const anchor of container.querySelectorAll?.("a[href]") ?? []) {
      try {
        const url = new URL(anchor.href, window.location.href);
        if (["instagram.com", "www.instagram.com"].includes(url.hostname) &&
            nativePostPattern.test(url.pathname)) {
          return url.href;
        }
      } catch {
        // Ignore malformed DOM hrefs; the native source URL must fail closed.
      }
    }
    return null;
  }

  function instagramProfileAnchors(container) {
    return [...(container.querySelectorAll?.('a[href^="/"]') ?? [])].filter((anchor) => {
      try {
        const url = new URL(anchor.href, window.location.href);
        const parts = url.pathname.split("/").filter(Boolean);
        return ["instagram.com", "www.instagram.com"].includes(url.hostname) &&
          parts.length === 1 && !reservedProfilePaths.has(parts[0].toLowerCase());
      } catch {
        return false;
      }
    });
  }

  function instagramAuthor(container, { compactText }) {
    for (const anchor of instagramProfileAnchors(container)) {
      const text = compactText(anchor.innerText || anchor.textContent);
      if (text) return text.slice(0, 300);
      const alt = compactText(anchor.querySelector?.("img")?.getAttribute?.("alt"));
      const match = alt.match(/^(.+?)(?:'s|’s) profile picture$/i);
      if (match?.[1]) return compactText(match[1]).slice(0, 300);
    }
    return "";
  }

  function instagramCaption(container, compactText) {
    const author = instagramAuthor(container, { compactText }).toLocaleLowerCase();
    const candidates = [...(container.querySelectorAll?.('span[dir="auto"]') ?? [])]
      .map((element) => ({
        element,
        text: compactText(element.innerText || element.textContent)
          .replace(/(?:\s+|^)(?:\.\.\.\s*)?more$/i, "")
          .trim(),
      }))
      .filter(({ element, text }) => text &&
        !element.closest?.("a,time") &&
        !element.closest?.('[role="button"]') &&
        text.toLocaleLowerCase() !== author &&
        !/^(?:sponsored|see translation|liked by|and others)$/i.test(text));
    candidates.sort((left, right) => right.text.length - left.text.length);
    return candidates[0]?.text ?? "";
  }

  function instagramMediaRoots(container, { excludeRoot, uniqueElements }) {
    const roots = uniqueElements([
      ...(container.querySelectorAll?.("video") ?? []),
      ...(container.querySelectorAll?.('img:not([alt*="profile picture" i])') ?? []),
    ]).filter((root) => !excludeRoot?.contains?.(root)).filter((root) => {
      const rect = root.getBoundingClientRect?.() ?? {};
      const width = rect.width || root.naturalWidth || root.videoWidth || 0;
      const height = rect.height || root.naturalHeight || root.videoHeight || 0;
      return width >= 180 && height >= 90;
    });
    return roots.map((root) => ({ root, kind: root.tagName === "VIDEO" ? "video" : "image" }));
  }

  function instagramEngagement(container, compactText) {
    const result = {};
    let activeKind = null;
    for (const control of container.querySelectorAll?.('[role="button"], button') ?? []) {
      const label = compactText(
        control.getAttribute?.("aria-label") ||
        control.querySelector?.("svg[aria-label]")?.getAttribute?.("aria-label") ||
        control.innerText,
      );
      if (/^(?:like|unlike)$/i.test(label)) {
        activeKind = "like";
        continue;
      }
      if (/^comment$/i.test(label)) {
        activeKind = "comment";
        continue;
      }
      if (/^(?:share|send|save|more options)$/i.test(label)) {
        activeKind = null;
        continue;
      }
      const count = label.match(/^[\d,.]+(?:[KMB])?$/i)?.[0];
      if (activeKind && count && !result[activeKind]) {
        result[activeKind] = count;
        activeKind = null;
      }
    }
    return result;
  }
})();
