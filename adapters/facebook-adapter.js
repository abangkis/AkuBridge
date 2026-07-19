(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  const candidateSelectors = Object.freeze([
    'div[aria-posinset]',
    '[role="feed"] > div [role="article"]',
    'main [role="feed"] [role="article"]',
    'main [role="article"]',
  ]);
  const postActionSelector = '[aria-label^="Actions for this post by "]';
  const postMediaSelector = [
    'a[href*="/photo"] img[src]',
    'a[href*="/videos/"] img[src]',
    '[data-ad-preview="message"] ~ * img[src]',
    'video',
  ].join(", ");

  registry.register({
    source: "facebook",
    version: "facebook-dom-v9",
    mediaHosts: Object.freeze(["fbcdn.net", "fbsbx.com"]),
    platformIdFromCandidates: (values) => {
      for (const value of Array.isArray(values) ? values : []) {
        const candidate = String(value ?? "");
        const id = candidate.match(/[?&](?:story_fbid|fbid|photo_id|v)=(\d+)/i)?.[1]
          ?? candidate.match(/[?&]set=pcb\.(\d+)/i)?.[1]
          ?? candidate.match(/\/(?:posts|videos)\/(pfbid[A-Za-z0-9]+|\d+)/i)?.[1];
        if (id) return `facebook:post:${id}`;
      }
      return null;
    },
    qualityProfile: "social-post-v2",
    evidenceProfile: Object.freeze({
      contentFamily: "feed_post",
      modalities: Object.freeze(["text", "image", "video", "attachment", "quoted_post"]),
    }),
    qualitySelectors: Object.freeze({
      author: `${postActionSelector}, h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], strong a[role="link"], `
        + 'a[role="link"][aria-label], a[role="link"][href*="facebook.com/"]',
      avatar: 'a[role="link"] img[src]',
      content: '[data-ad-preview="message"], [data-ad-comet-preview="message"], div[dir="auto"]',
      media: postMediaSelector,
      timestamp: 'a[target="_blank"], a[href*="/posts/"], '
        + 'a[href*="story_fbid="], a[href*="/permalink/"]',
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
    captureTuning: Object.freeze({
      // Facebook virtualizes its Home Feed aggressively. One ordinary 0.75-viewport
      // step can remain inside a single tall gallery post, so advance farther without
      // changing the bounded scroll count or the behavior of any other adapter.
      scrollStepMultiplier: 2,
    }),
    matchesPage: () => ["facebook.com", "www.facebook.com"].includes(window.location.hostname),
    availability: () => {
      const heading = [...document.querySelectorAll("h1, h2, h3")]
        .map((node) => String(node.textContent ?? "").trim())
        .find(Boolean) ?? "";
      const pageText = `${heading}\n${String(document.body?.innerText ?? "").slice(0, 2_000)}`;
      const pathOutage = window.location.pathname === "/sorry.php"
        && new URLSearchParams(window.location.search).get("msg") === "account";
      const textOutage = /account temporarily unavailable/i.test(pageText)
        && /unavailable due to a site issue/i.test(pageText)
        && !document.querySelector('div[aria-posinset], [role="feed"]');
      const unavailable = pathOutage || textOutage;
      if (!unavailable) return null;
      return Object.freeze({
        state: "source_unavailable",
        code: "site_outage",
        message: "Facebook reports that the account is temporarily unavailable due to a site issue.",
        retryable: true,
      });
    },
    loginRequired: () => /\/login|\/checkpoint/i.test(window.location.pathname) || Boolean(
      document.querySelector('input[name="email"], input[name="pass"], form[action*="login"]'),
    ),
    feedRootPresent: () => Boolean(document.querySelector('div[aria-posinset], main [role="feed"], [role="feed"], main')),
    discoverCandidates: ({ uniqueElements }) => {
      const selectorCounts = Object.fromEntries(candidateSelectors.map((selector) => [
        selector,
        document.querySelectorAll(selector).length,
      ]));
      const actionAnchoredCandidates = [...document.querySelectorAll(postActionSelector)]
        .map((action) => action.closest?.('div[aria-posinset], [role="article"]'))
        .filter(Boolean);
      const candidates = uniqueElements([
        ...actionAnchoredCandidates,
        ...candidateSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]),
      ]).filter(isTopLevelFeedPost);
      return {
        candidates,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: actionAnchoredCandidates.length,
        strategy: actionAnchoredCandidates.length > 0
          ? "post_action_anchor"
          : candidateSelectors.find((selector) => selectorCounts[selector] > 0) ?? "none",
        selectorCounts: { ...selectorCounts, [postActionSelector]: actionAnchoredCandidates.length },
      };
    },
    findAuthor: (container, { compactText }) => {
      const actionAuthor = facebookActionAuthor(container, compactText);
      if (actionAuthor) return actionAuthor;
      for (const selector of ['h2 a[role="link"]', 'h3 a[role="link"]', 'h4 a[role="link"]', 'strong a[role="link"]']) {
        const author = compactText(container.querySelector(selector)?.innerText);
        if (author && !/^(?:Facebook|Sponsored)$/i.test(author)) return author.slice(0, 300);
      }
      return facebookHeaderAuthor(container, compactText);
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
      /\/watch\/\?v=/,
      /\/video\.php\?v=/,
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
        ? facebookCanonicalPostURLs(container, normalizeHttpUrl)[1] ?? null
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
      const timestampText = facebookRenderedRelativeTime(container)
        || lines.find((line) => /^\d+\s*(?:m|h|d|w|mo|y)\b/i.test(line))
        || "";
      return {
        socialContext: lines.find((line) => /\bshared (?:this|a post)|commented on this$/i.test(line)) ?? "",
        attributionText: sponsored ? "Sponsored" : "",
        timestampText,
        timestampAvailability: timestampText
          ? "relative_text"
          : sponsored
            ? "not_exposed_promoted"
            : "unavailable",
        promoted: sponsored,
      };
    },
    estimateRelativeTimestamp: estimateFacebookRelativeTimestamp,
    findPermalinkDetails: (container, { normalizeHttpUrl }) => {
      const evidence = facebookPostPermalink(container, normalizeHttpUrl);
      return evidence?.url ? evidence : null;
    },
    imageSelector: "img[src]",
    shouldSkipImage: (image) => {
      const rect = image.getBoundingClientRect();
      return Boolean(image.closest('a[role="link"]')) && rect.width <= 96 && rect.height <= 96;
    },
  });

  function isTopLevelFeedPost(candidate) {
    if (candidate.closest?.('[aria-label="Stories"], [aria-label="Reels"]')) return false;
    if (candidate.querySelector?.('[aria-label^="Actions for this reel by "]')) return false;
    const actions = [...candidate.querySelectorAll('[role="button"], button')]
      .map((button) => String(button.getAttribute?.("aria-label") || button.innerText || "").trim())
      .map(facebookActionKind)
      .filter(Boolean);
    if (new Set(actions).size < 2) return false;
    return !candidate.parentElement?.closest?.('[role="article"]');
  }

  function facebookActionAuthor(container, compactText) {
    const label = compactText(container.querySelector?.(postActionSelector)?.getAttribute?.("aria-label"));
    const author = label.match(/^Actions for this post by (.+)$/i)?.[1]?.trim() ?? "";
    return isFacebookAuthorLabel(author) ? author.slice(0, 300) : "";
  }

  function facebookHeaderAuthor(container, compactText) {
    const contentRoot = container.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
    );
    for (const anchor of container.querySelectorAll('a[role="link"][href]')) {
      if (contentRoot && typeof anchor.compareDocumentPosition === "function") {
        const followsContent = anchor.compareDocumentPosition(contentRoot) & 2;
        if (followsContent) continue;
      }
      const label = compactText(anchor.innerText || anchor.getAttribute?.("aria-label"));
      if (!isFacebookAuthorLabel(label) || !isFacebookProfileLink(anchor.href)) continue;
      return label.slice(0, 300);
    }
    return "";
  }

  function isFacebookAuthorLabel(value) {
    return value.length >= 2 && value.length <= 120 &&
      !/^(?:Facebook|Sponsored|See more|See less|Hide post\b|Online status indicator\b|Active$)/i.test(value);
  }

  function isFacebookProfileLink(value) {
    try {
      const url = new URL(String(value ?? ""), "https://www.facebook.com/");
      if (url.hostname !== "facebook.com" && url.hostname !== "www.facebook.com") return false;
      if (/^\/profile\.php$/i.test(url.pathname)) return Boolean(url.searchParams.get("id"));
      return !isFacebookNavigationPath(url.pathname);
    } catch {
      return false;
    }
  }

  function facebookRenderedRelativeTime(container) {
    const readStyle = typeof globalThis.getComputedStyle === "function"
      ? (element) => globalThis.getComputedStyle(element)
      : typeof globalThis.window?.getComputedStyle === "function"
        ? (element) => globalThis.window.getComputedStyle(element)
        : null;
    if (typeof readStyle !== "function") return "";
    for (const anchor of container.querySelectorAll('a[target="_blank"]')) {
      const glyphs = [...anchor.querySelectorAll("span")].map((span) => {
        const value = String(span.textContent ?? "").trim();
        if (!/^[0-9smhdwy]$/i.test(value)) return null;
        const style = readStyle(span);
        const rect = span.getBoundingClientRect?.();
        if (style?.position === "absolute" || style?.display === "none" ||
            style?.visibility === "hidden" || Number(style?.opacity) === 0 ||
            !rect || rect.width <= 0 || rect.height <= 0) return null;
        return { value, x: rect.left, y: rect.top };
      }).filter(Boolean).sort((left, right) => Math.abs(left.y - right.y) > 2
        ? left.y - right.y
        : left.x - right.x);
      const value = glyphs.map((glyph) => glyph.value).join("").toLowerCase();
      if (/^\d{1,3}(?:m|h|d|w|y)$/.test(value)) return value;
    }
    return "";
  }

  function estimateFacebookRelativeTimestamp(value, capturedAt) {
    const match = String(value ?? "").trim().match(/^(\d{1,3})\s*(m|h|d|w|y)\b/i);
    const capturedMs = Date.parse(capturedAt);
    if (!match || !Number.isFinite(capturedMs)) return null;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (!Number.isInteger(amount) || amount < 1) return null;
    const estimate = new Date(capturedMs);
    const precision = { m: "minute", h: "hour", d: "day", w: "week", y: "year" }[unit];
    if (unit === "m") {
      estimate.setUTCSeconds(0, 0);
      estimate.setUTCMinutes(estimate.getUTCMinutes() - amount);
    } else if (unit === "h") {
      estimate.setUTCMinutes(0, 0, 0);
      estimate.setUTCHours(estimate.getUTCHours() - amount);
    } else if (unit === "d") {
      estimate.setUTCHours(0, 0, 0, 0);
      estimate.setUTCDate(estimate.getUTCDate() - amount);
    } else if (unit === "w") {
      estimate.setUTCHours(0, 0, 0, 0);
      estimate.setUTCDate(estimate.getUTCDate() - amount * 7);
    } else {
      estimate.setTime(Date.UTC(estimate.getUTCFullYear() - amount, 0, 1));
    }
    return {
      publishedAt: estimate.toISOString(),
      amount,
      unit,
      precision,
      estimated: true,
    };
  }

  function facebookActionKind(label) {
    if (/^(?:Like|React)(?:\b|$)/i.test(label)) return "like";
    if (/^(?:Comment|Leave a comment)(?:\b|$)/i.test(label)) return "comment";
    if (/^(?:Share|Send)(?:\b|$)/i.test(label)) return "share";
    return "";
  }

  function facebookPostPermalink(container, normalizeHttpUrl) {
    const values = facebookCanonicalPostURLs(container, normalizeHttpUrl, true);
    return values[0] ?? null;
  }

  function facebookCanonicalPostURLs(container, normalizeHttpUrl, withSource = false) {
    const anchors = [...container.querySelectorAll('a[href]')];
    const direct = anchors.map((anchor) => canonicalFacebookPostURL(anchor.href, normalizeHttpUrl))
      .filter(Boolean);
    const uniqueDirect = [...new Map(direct.map((entry) => [entry.url, entry])).values()];
    if (uniqueDirect.length) return withSource ? uniqueDirect : uniqueDirect.map((entry) => entry.url);

    const author = facebookProfileIdentity(container);
    const parentPostIds = anchors.map((anchor) => {
      try {
        return new URL(anchor.href).searchParams.get("set")?.match(/^pcb\.(\d+)$/i)?.[1] ?? null;
      } catch {
        return null;
      }
    }).filter(Boolean);
    const fallback = [...new Set(parentPostIds)].map((postId) => {
      const url = author?.path
        ? `https://www.facebook.com${author.path}/posts/${postId}/`
        : author?.id
          ? `https://www.facebook.com/story.php?story_fbid=${postId}&id=${author.id}`
          : null;
      return url ? { url, source: "media_parent_id" } : null;
    }).filter(Boolean);
    return withSource ? fallback : fallback.map((entry) => entry.url);
  }

  function canonicalFacebookPostURL(value, normalizeHttpUrl) {
    const normalized = normalizeHttpUrl(value);
    if (!normalized) return null;
    try {
      const url = new URL(normalized);
      if (url.hostname !== "facebook.com" && url.hostname !== "www.facebook.com") return null;
      const postPath = url.pathname.match(/^(\/(?:groups\/[^/]+|[^/]+)\/posts\/(?:pfbid[A-Za-z0-9]+|\d+))\/?$/i);
      if (postPath) return { url: `https://www.facebook.com${postPath[1]}/`, source: "post_anchor" };
      const videoPath = url.pathname.match(/^(\/(?:[^/]+\/)?videos\/(\d+))\/?$/i);
      if (videoPath) return { url: `https://www.facebook.com${videoPath[1]}/`, source: "video_anchor" };
      if (/^\/(?:watch\/|video\.php)$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get("v") ?? "")) {
        return { url: `https://www.facebook.com/watch/?v=${url.searchParams.get("v")}`, source: "video_anchor" };
      }
      if (/^\/(?:story|permalink)\.php$/i.test(url.pathname)) {
        const story = url.searchParams.get("story_fbid");
        const owner = url.searchParams.get("id");
        if (/^\d+$/.test(story ?? "") && /^\d+$/.test(owner ?? "")) {
          return {
            url: `https://www.facebook.com/story.php?story_fbid=${story}&id=${owner}`,
            source: "story_anchor",
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function facebookProfileIdentity(container) {
    for (const anchor of container.querySelectorAll('a[role="link"][href]')) {
      try {
        const url = new URL(anchor.href);
        if (url.hostname !== "facebook.com" && url.hostname !== "www.facebook.com") continue;
        if (/^\/profile\.php$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get("id") ?? "")) {
          return { id: url.searchParams.get("id"), path: "" };
        }
        if (/^\/[^/?#]+\/?$/.test(url.pathname) && !isFacebookNavigationPath(url.pathname)) {
          return { id: "", path: url.pathname.replace(/\/$/, "") };
        }
      } catch {
        // Ignore non-URL evidence.
      }
    }
    return null;
  }

  function isFacebookNavigationPath(value) {
    return /^\/(?:$|watch|marketplace|groups|events|gaming|reel|photo|photos|videos|posts|permalink|story\.php)(?:\/|$)/i.test(value);
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
