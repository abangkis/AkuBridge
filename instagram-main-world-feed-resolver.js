// This function is intentionally self-contained so Chrome can serialize it into the MAIN world.
// It returns only bounded, sanitized Instagram feed evidence when the rendered DOM feed is absent.
export function resolveInstagramStructuredFeedInMainWorld(request = {}) {
  const runtimeRevision = "instagram-main-world-feed-resolver-v1";
  const maxCandidates = clamp(request.maxCandidates, 1, 12, 5);
  const maxMediaPerCandidate = clamp(request.maxMediaPerCandidate, 1, 4, 4);
  const maxScripts = clamp(request.maxScripts, 1, 64, 48);
  const maxDocumentScripts = clamp(request.maxDocumentScripts, 1, 128, 96);
  const maxScriptBytes = clamp(request.maxScriptBytes, 8_192, 512_000, 300_000);
  const maxTotalBytes = clamp(request.maxTotalBytes, 64_000, 4_000_000, 2_000_000);
  const maxTraversalNodes = clamp(request.maxTraversalNodes, 500, 40_000, 20_000);
  const maxDepth = clamp(request.maxDepth, 8, 48, 40);
  const maxCaptionCharacters = clamp(request.maxCaptionCharacters, 200, 4_000, 4_000);
  const candidates = new Map();
  let inspectedScriptCount = 0;
  let parsedScriptCount = 0;
  let rejectedScriptCount = 0;
  let inspectedBytes = 0;
  let traversedNodeCount = 0;
  let rejectedPromotedCount = 0;

  const pageDocument = typeof document === "undefined" ? null : document;
  const documentScripts = [...(pageDocument?.querySelectorAll?.(
    'script[type="application/json"]',
  ) ?? [])].slice(0, maxDocumentScripts);
  const scripts = documentScripts.filter((script) => {
    const text = typeof script?.textContent === "string" ? script.textContent : "";
    return text.includes('"image_versions2"') && text.includes('"code"');
  }).slice(0, maxScripts);

  for (const script of scripts) {
    if (candidates.size >= maxCandidates || traversedNodeCount >= maxTraversalNodes) break;
    const text = typeof script?.textContent === "string" ? script.textContent : "";
    if (!text || text.length > maxScriptBytes || inspectedBytes + text.length > maxTotalBytes) {
      if (text) rejectedScriptCount += 1;
      continue;
    }
    inspectedScriptCount += 1;
    inspectedBytes += text.length;
    let root;
    try {
      root = JSON.parse(text);
      parsedScriptCount += 1;
    } catch {
      rejectedScriptCount += 1;
      continue;
    }
    const queue = [{ value: root, depth: 0 }];
    const seen = new Set();
    while (queue.length && traversedNodeCount < maxTraversalNodes && candidates.size < maxCandidates) {
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      traversedNodeCount += 1;
      const candidate = candidateFromObject(value);
      if (candidate?.promoted) {
        rejectedPromotedCount += 1;
      } else if (candidate && !candidates.has(candidate.candidateId)) {
        candidates.set(candidate.candidateId, candidate);
      }
      if (current.depth >= maxDepth) continue;
      for (const child of dataValues(value, 180)) {
        if (isObject(child) && !seen.has(child)) queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return Object.freeze({
    runtimeRevision,
    resolverVersion: "instagram-structured-feed-v1",
    candidates: [...candidates.values()].map(({ promoted, ...candidate }) => candidate),
    diagnostics: Object.freeze({
      documentScriptCount: documentScripts.length,
      feedScriptCount: scripts.length,
      inspectedScriptCount,
      parsedScriptCount,
      rejectedScriptCount,
      rejectedPromotedCount,
      inspectedBytes,
      traversedNodeCount,
      candidateCount: candidates.size,
      bounded: traversedNodeCount >= maxTraversalNodes || inspectedBytes >= maxTotalBytes,
    }),
  });

  function candidateFromObject(value) {
    const shortcode = normalizeShortcode(dataProperty(value, "code"));
    const user = dataProperty(value, "user");
    const username = normalizeUsername(dataProperty(user, "username"));
    const imageVersions = dataProperty(dataProperty(value, "image_versions2"), "candidates");
    if (!shortcode || !username || !Array.isArray(imageVersions) || imageVersions.length === 0) return null;
    const productType = boundedText(dataProperty(value, "product_type"), 40).toLowerCase();
    const sponsorTags = dataProperty(value, "sponsor_tags");
    const promoted = productType === "ad" || dataProperty(value, "is_paid_partnership") === true ||
      (Array.isArray(sponsorTags) && sponsorTags.length > 0);
    const media = collectMedia(value);
    const caption = boundedText(dataProperty(dataProperty(value, "caption"), "text"), maxCaptionCharacters);
    if (!caption && media.length === 0) return null;
    const takenAt = positiveInteger(dataProperty(value, "taken_at"));
    const nativeKind = productType === "clips" ? "reel" : "p";
    const permalink = canonicalInstagramPostUrl(dataProperty(value, "link"), shortcode) ??
      `https://www.instagram.com/${nativeKind}/${shortcode}/`;
    return {
      candidateId: `instagram:post:${shortcode}`,
      platformId: `instagram:${nativeKind}:${shortcode}`,
      permalink,
      author: username,
      avatarUrl: safeInstagramImageUrl(dataProperty(user, "profile_pic_url")),
      text: caption,
      publishedAt: takenAt ? new Date(takenAt * 1_000).toISOString() : null,
      contentKind: media.some((entry) => entry.kind === "video") ? "video" : "post",
      engagement: {
        like: boundedCount(dataProperty(value, "like_count")),
        comment: boundedCount(dataProperty(value, "comment_count")),
      },
      media,
      promoted,
    };
  }

  function collectMedia(value) {
    const roots = [value];
    const carousel = dataProperty(value, "carousel_media");
    if (Array.isArray(carousel)) roots.push(...carousel.slice(0, maxMediaPerCandidate));
    const result = [];
    const seen = new Set();
    for (const root of roots) {
      const image = bestMedia(dataProperty(dataProperty(root, "image_versions2"), "candidates"), "image");
      const video = bestMedia(dataProperty(root, "video_versions"), "video");
      const entry = video && image
        ? {
            kind: "video",
            url: image.url,
            posterUrl: image.url,
            playbackUrl: video.url,
            playbackMode: "inline",
            width: video.width || image.width,
            height: video.height || image.height,
            provenance: "instagram_structured_feed_json",
          }
        : image
          ? {
              kind: "image",
              url: image.url,
              width: image.width,
              height: image.height,
              provenance: "instagram_structured_feed_json",
            }
          : null;
      const key = entry?.playbackUrl || entry?.url;
      if (!entry || !key || seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
      if (result.length >= maxMediaPerCandidate) break;
    }
    return result;
  }

  function bestMedia(values, kind) {
    const candidates = [];
    for (const entry of Array.isArray(values) ? values.slice(0, 12) : []) {
      const url = kind === "video"
        ? safeInstagramVideoUrl(dataProperty(entry, "url"))
        : safeInstagramImageUrl(dataProperty(entry, "url"));
      if (!url) continue;
      candidates.push({
        url,
        width: positiveInteger(dataProperty(entry, "width")),
        height: positiveInteger(dataProperty(entry, "height")),
      });
    }
    candidates.sort((left, right) => right.width * right.height - left.width * left.height);
    return candidates[0] ?? null;
  }

  function normalizeShortcode(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9_-]{3,80}$/.test(text) ? text : null;
  }

  function normalizeUsername(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9._]{1,80}$/.test(text) ? text : null;
  }

  function canonicalInstagramPostUrl(value, shortcode) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value, "https://www.instagram.com/");
      const match = url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]{3,80})\/?$/i);
      if (
        url.protocol !== "https:" ||
        !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) ||
        match?.[2] !== shortcode
      ) return null;
      return `https://www.instagram.com/${match[1].toLowerCase()}/${shortcode}/`;
    } catch { return null; }
  }

  function boundedText(value, limit) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  }

  function boundedCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? String(Math.min(1_000_000_000, Math.trunc(number))) : "";
  }

  function safeInstagramVideoUrl(value) {
    const url = safeInstagramMediaUrl(value);
    return url && /\.mp4$/i.test(new URL(url).pathname) ? url : null;
  }

  function safeInstagramImageUrl(value) {
    const url = safeInstagramMediaUrl(value);
    return url && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname) ? url : null;
  }

  function safeInstagramMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["fbcdn.net", "cdninstagram.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
        return null;
      }
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function dataValues(value, limit) {
    return ownNames(value, limit).flatMap((key) => {
      const child = dataProperty(value, key);
      return child === undefined ? [] : [child];
    });
  }

  function ownNames(value, limit) {
    try { return isObject(value) ? Object.getOwnPropertyNames(value).slice(0, limit) : []; }
    catch { return []; }
  }

  function dataProperty(value, key) {
    if (!isObject(value)) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    } catch { return undefined; }
  }

  function isObject(value) { return value !== null && typeof value === "object"; }
  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(10_000_000_000, Math.trunc(number)) : 0;
  }
  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
  }
}

export function instagramStructuredFeedObservation(evidence, { capturedAt = new Date().toISOString() } = {}) {
  const candidates = Array.isArray(evidence?.candidates) ? evidence.candidates.slice(0, 5) : [];
  const blocks = candidates.map((candidate, index) => ({
    text: String(candidate.text ?? "").slice(0, 4_000),
    author: String(candidate.author ?? "").slice(0, 80),
    avatarUrl: candidate.avatarUrl ?? null,
    publishedAt: candidate.publishedAt ?? null,
    permalink: candidate.permalink,
    platformId: candidate.platformId,
    contentKind: candidate.contentKind === "video" ? "video" : "post",
    relationshipType: "original",
    parentPermalink: null,
    quotedPost: null,
    engagement: candidate.engagement ?? {},
    presentation: {
      promoted: false,
      permalinkSource: "instagram_structured_feed_json",
      timestampSource: candidate.publishedAt ? "native_datetime" : "unavailable",
      timestampEstimated: false,
      timestampPrecision: candidate.publishedAt ? "exact" : "unknown",
      contentExpansion: "not_applicable",
    },
    attachments: [],
    media: Array.isArray(candidate.media) ? candidate.media.slice(0, 4) : [],
    links: [],
    mediaRecovery: { outcome: "structured_feed_native" },
    captureQuality: { verdict: "usable_degraded", issues: [] },
    feedPosition: index + 1,
  }));
  return {
    source: "instagram",
    pageUrl: "https://www.instagram.com/",
    pageTitle: "Instagram",
    capturedAt,
    snapshots: [{
      index: 0,
      adapterVersion: "instagram-dom-v4",
      selectorStrategy: "instagram_structured_feed_json",
      selectorCounts: { structured_feed_candidate: blocks.length },
      selectorCandidateCount: blocks.length,
      structuralCandidateCount: 0,
      visibleContainerCount: 0,
      capturedAt,
      scrollY: 0,
      viewportHeight: 0,
      newCandidateCount: blocks.length,
      blocks,
      qualityReports: blocks.map(() => ({ verdict: "usable_degraded", issues: [] })),
    }],
    coverage: {
      status: blocks.length ? "partial" : "unavailable",
      checkedThrough: capturedAt,
      candidateCount: blocks.length,
      observedBlockCount: blocks.length,
      browserAdapter: "aku-bridge",
      captureMethod: "instagram_structured_feed_json",
      adapterVersion: "instagram-dom-v4",
      captureQuality: { verdict: "usable_degraded", issues: [] },
      structuredFeedEvidence: evidence?.diagnostics ?? null,
      sourceFreshness: { status: "ready", outcome: "structured_feed_bootstrap" },
      frontier: { scrollY: 0, anchorKeys: [], newCandidateCount: blocks.length, hasMoreCandidateSignal: false },
      performedScrolls: 0,
      requestedScrolls: 0,
      snapshotCount: 1,
      scrollStopReason: "structured_fallback",
      restoreAttempted: false,
      restored: true,
      elapsedMs: 0,
    },
  };
}

export function shouldUseInstagramStructuredFeedFallback({ source, configuredFallback, readiness } = {}) {
  return source === "instagram" &&
    configuredFallback === "instagram_structured_feed_v1" &&
    readiness?.diagnosis === "feed_shell_unhydrated" &&
    readiness?.feedRootPresent === true &&
    Number(readiness?.selectorCandidateCount ?? 0) === 0 &&
    Number(readiness?.structuralCandidateCount ?? 0) === 0;
}
