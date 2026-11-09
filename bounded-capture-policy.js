(() => {
  if (globalThis.AkuBoundedCapturePolicy) return;

  const limits = Object.freeze({
    maxScrolls: 6,
    minScrollFraction: 0.5,
    maxScrollFraction: 0.9,
    maxScrollSettleMs: 2_000,
    maxCaptureTimeoutMs: 45_000,
    maxPendingContentTimeoutMs: 5_000,
    maxPendingContentSettleMs: 2_000,
    maxBlocksPerSnapshot: 20,
    maxBlockCharacters: 4_000,
    maxMediaPerBlock: 20,
    maxQualityRetryBudget: 1,
    maxQualityRetrySettleMs: 1_000,
  });

  function normalizeCapturePlan(payload = {}) {
    const acquisitionRound = clampInteger(payload.acquisitionRound, 1, 2, 1);
    const sameTabMutationAllowed =
      acquisitionRound === 1 &&
      payload.pendingContentPolicy === "reveal_if_present" &&
      payload.sameTabMutationAllowed === true;
    return Object.freeze({
      source: payload.source,
      scrolls: clampInteger(payload.scrolls, 0, limits.maxScrolls, 0),
      scrollFraction: clampNumber(
        payload.scrollFraction,
        limits.minScrollFraction,
        limits.maxScrollFraction,
        0.75,
      ),
      scrollSettleMs: clampInteger(
        payload.scrollSettleMs,
        100,
        limits.maxScrollSettleMs,
        900,
      ),
      captureTimeoutMs: clampInteger(
        payload.captureTimeoutMs,
        1_000,
        limits.maxCaptureTimeoutMs,
        limits.maxCaptureTimeoutMs,
      ),
      pendingContentPolicy:
        sameTabMutationAllowed ? "reveal_if_present" : "detect_only",
      sameTabMutationAllowed,
      pendingContentTimeoutMs: clampInteger(
        payload.pendingContentTimeoutMs,
        500,
        limits.maxPendingContentTimeoutMs,
        limits.maxPendingContentTimeoutMs,
      ),
      pendingContentSettleMs: clampInteger(
        payload.pendingContentSettleMs,
        100,
        limits.maxPendingContentSettleMs,
        700,
      ),
      maxBlocksPerSnapshot: clampInteger(
        payload.maxBlocksPerSnapshot,
        1,
        limits.maxBlocksPerSnapshot,
        limits.maxBlocksPerSnapshot,
      ),
      maxBlockCharacters: clampInteger(
        payload.maxBlockCharacters,
        40,
        limits.maxBlockCharacters,
        limits.maxBlockCharacters,
      ),
      qualityRetryBudget: clampInteger(
        payload.qualityRetryBudget,
        0,
        limits.maxQualityRetryBudget,
        0,
      ),
      qualityRetrySettleMs: clampInteger(
        payload.qualityRetrySettleMs,
        100,
        limits.maxQualityRetrySettleMs,
        300,
      ),
      acquisitionRound,
      continuation: acquisitionRound === 2 ? normalizeContinuation(payload.continuation) : null,
      restoreScroll: true,
    });
  }

  function countNewCandidates(blocks, seen) {
    let count = 0;
    for (const block of blocks) {
      const text = typeof block?.text === "string" ? block.text.replace(/\s+/g, " ").trim() : "";
      const key = block?.permalink || text.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
    return count;
  }

  function hasChangedVisibleFeed(beforeFingerprint, afterFingerprint) {
    return (
      typeof beforeFingerprint === "string" &&
      beforeFingerprint.length > 0 &&
      typeof afterFingerprint === "string" &&
      afterFingerprint.length > 0 &&
      beforeFingerprint !== afterFingerprint
    );
  }

  function platformIdFromCandidates(source, values) {
    const adapter = globalThis.AkuSourceAdapters?.get?.(source);
    if (typeof adapter?.platformIdFromCandidates === "function") {
      return adapter.platformIdFromCandidates(values) ?? null;
    }
    for (const value of Array.isArray(values) ? values : []) {
      const candidate = typeof value === "string" ? value : "";
      if (!candidate) continue;
    }
    return null;
  }

  function normalizeMediaCandidates(source, values) {
    const seen = new Map();
    const media = [];
    const diagnostics = {
      candidateCount: 0,
      urlPresentCount: 0,
      urlMissingCount: 0,
      rejectedHostCount: 0,
      rejectedGeometryCount: 0,
      duplicateCount: 0,
      acceptedCount: 0,
      trustedUnknownGeometryAcceptedCount: 0,
      urlSources: {},
    };
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || typeof value !== "object") continue;
      diagnostics.candidateCount += 1;
      const rawURL = value.posterUrl || value.url;
      if (rawURL) diagnostics.urlPresentCount += 1;
      else diagnostics.urlMissingCount += 1;
      const urlSource = typeof value.urlSource === "string" && value.urlSource.trim()
        ? value.urlSource.trim().slice(0, 40)
        : "unknown";
      diagnostics.urlSources[urlSource] = (diagnostics.urlSources[urlSource] ?? 0) + 1;
      const kind = value.kind === "video" || value.kind === "video_poster" ? "video" : "image";
      const url = safeMediaUrl(source, rawURL);
      if (!url) {
        if (rawURL) diagnostics.rejectedHostCount += 1;
        continue;
      }
      const playbackUrl = kind === "video" ? safeMediaUrl(source, value.playbackUrl) : null;
      const inlineUrl = source === "x" && playbackUrl && !isXMP4(playbackUrl)
        ? xHlsMasterUrl(url, playbackUrl)
        : playbackUrl;
      const width = clampInteger(Math.round(value.width), 0, 8_192, 0);
      const height = clampInteger(Math.round(value.height), 0, 8_192, 0);
      const unknownGeometry = width === 0 && height === 0;
      const trustedUnknownGeometry = globalThis.AkuSourceAdapters?.get?.(source)
        ?.mediaAcquisition?.allowTrustedUnknownGeometry === true &&
        value.trustedMediaRoot === true && unknownGeometry;
      if ((width < 180 || height < 90) && !trustedUnknownGeometry) {
        diagnostics.rejectedGeometryCount += 1;
        continue;
      }
      if (trustedUnknownGeometry) diagnostics.trustedUnknownGeometryAcceptedCount += 1;
      const identity = mediaIdentity(source, url);
      const previous = seen.get(identity);
      const candidate = createMediaCandidate(value, kind, url, inlineUrl, width, height);
      if (previous) {
        diagnostics.duplicateCount += 1;
        const prior = media[previous.index];
        const playbackPriority = source === "x" ? xPlaybackRank(candidate) - xPlaybackRank(prior) : 0;
        if (playbackPriority ? playbackPriority > 0 : preferMediaCandidate(value, previous.input, url, previous.url)) {
          media[previous.index] = candidate;
          seen.set(identity, { ...previous, input: value, url });
        }
        continue;
      }
      seen.set(identity, { index: media.length, input: value, url });
      media.push(candidate);
      if (media.length >= limits.maxMediaPerBlock) break;
    }
    diagnostics.acceptedCount = media.length;
    diagnostics.urlSources = Object.freeze({ ...diagnostics.urlSources });
    Object.defineProperty(media, "diagnostics", {
      value: Object.freeze(diagnostics),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return Object.freeze(media);
  }

  function isXMP4(value) {
    const url = new URL(value);
    return url.origin === "https://video.twimg.com" && !url.username && !url.password &&
      /^\/(?:amplify_video|ext_tw_video|tweet_video)\/.+\.mp4$/i.test(url.pathname);
  }

  function xHlsMasterUrl(poster, playback) {
    const posterURL = xVideoCDNUrl(poster, "https://pbs.twimg.com");
    const playlist = xVideoCDNUrl(playback, "https://video.twimg.com");
    const owner = /^\/(amplify_video|ext_tw_video|tweet_video)_thumb\/(\d{1,30})\//.exec(posterURL?.pathname ?? "");
    const master = /^\/(amplify_video|ext_tw_video|tweet_video)\/(\d{1,30})\/(?:pu\/)?pl\/[\w.-]+\.m3u8$/.exec(playlist?.pathname ?? "");
    return owner && master && owner[1] === master[1] && owner[2] === master[2] ? playlist.href : null;
  }

  function xVideoCDNUrl(value, origin) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (url.origin !== origin || url.username || url.password || /%2f|%5c/i.test(url.pathname)) return null;
      url.hash = "";
      return url;
    } catch {
      return null;
    }
  }

  function findXHlsMasterUrl(poster, entries) {
    for (let index = entries.length - 1; index >= Math.max(0, entries.length - 250); index--) {
      const { name, responseStatus } = entries[index];
      if (!name?.startsWith("https://video.twimg.com/") || !/\.m3u8(?:[?#]|$)/.test(name) ||
          responseStatus > 0 && responseStatus !== 304 && (responseStatus < 200 || responseStatus >= 300)) continue;
      const playlist = xHlsMasterUrl(poster, name);
      if (playlist) return playlist;
    }
    return null;
  }

  function xPlaybackRank(media) {
    if (media.kind !== "video" || media.playbackMode !== "inline") return 0;
    const playback = safeMediaUrl("x", media.playbackUrl);
    if (!playback) return 0;
    if (isXMP4(playback)) return 2;
    return xHlsMasterUrl(media.posterUrl || media.url, playback) ? 1 : 0;
  }

  function createMediaCandidate(value, kind, url, playbackUrl, width, height) {
    return Object.freeze({
      kind,
      url,
      posterUrl: kind === "video" ? url : null,
      playbackUrl,
      playbackMode: kind === "video" && playbackUrl && value.playbackMode !== "native"
        ? "inline"
        : kind === "video"
          ? "native"
          : null,
      alt: typeof value.alt === "string" ? value.alt.trim().slice(0, 300) : "",
      width,
      height,
    });
  }

  function mediaIdentity(source, url) {
    // A poster identifies the rendered media item. Playback is enrichment for
    // that item and must not turn the same poster into a second carousel slot.
    return assetIdentity(source, url);
  }

  function assetIdentity(source, value) {
    if (source === "x") return xAssetIdentity(value);
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      url.hash = "";
      url.searchParams.sort();
      return url.href;
    } catch {
      return String(value ?? "");
    }
  }

  // X serves the same pbs.twimg.com media entity both as `/ID.jpg` from its
  // response payload and as `/ID?format=jpg&name=small` in the hydrated DOM.
  // Keep those presentation URLs intact, but use one stable identity for all
  // size/format variants of a `/media/` entity.
  function xAssetIdentity(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      url.hash = "";
      if (url.hostname.toLowerCase() === "pbs.twimg.com") {
        if (/^\/media\//i.test(url.pathname)) {
          url.pathname = url.pathname.replace(/\.(?:jpe?g|png|gif|webp|avif)$/i, "");
          url.searchParams.delete("format");
        }
        url.searchParams.delete("name");
      }
      url.searchParams.sort();
      return url.href;
    } catch {
      return String(value ?? "");
    }
  }

  function preferMediaCandidate(candidate, previous, candidateURL, previousURL) {
    const candidateArea = mediaDimensionScore(candidate);
    const previousArea = mediaDimensionScore(previous);
    if (candidateArea !== previousArea) return candidateArea > previousArea;
    const candidateSource = mediaSourceRank(candidate);
    const previousSource = mediaSourceRank(previous);
    if (candidateSource !== previousSource) return candidateSource > previousSource;
    const candidateVariant = mediaVariantRank(candidateURL);
    const previousVariant = mediaVariantRank(previousURL);
    if (candidateVariant !== previousVariant) return candidateVariant > previousVariant;
    return String(candidateURL).length < String(previousURL).length;
  }

  function mediaDimensionScore(value) {
    const width = Number(value?.width) || 0;
    const height = Number(value?.height) || 0;
    return width * height;
  }

  function mediaSourceRank(value) {
    const source = String(value?.urlSource || value?.provenance || "").toLowerCase();
    return {
      x_response_graphql: 50,
      main_structured_state: 40,
      current_src: 30,
      src_property: 25,
      src_attribute: 20,
      observed_dom: 15,
      css_background: 10,
    }[source] || 0;
  }

  function mediaVariantRank(value) {
    try {
      const url = new URL(value);
      const name = (url.searchParams.get("name") || "").toLowerCase();
      return {
        orig: 50,
        original: 50,
        large: 40,
        medium: 30,
        small: 20,
      }[name] || (name ? 10 : 35);
    } catch {
      return 0;
    }
  }

  function safeMediaUrl(source, value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      const hosts = globalThis.AkuSourceAdapters?.get?.(source)?.mediaHosts ?? [];
      if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function mediaUrlFromCssBackground(value) {
    if (typeof value !== "string" || value === "none") return null;
    const match = value.match(/url\((?:["']?)(https:\/\/[^"')]+)(?:["']?)\)/i);
    return match?.[1] ?? null;
  }

  function normalizeContinuation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const anchorKeys = Array.isArray(value.anchorKeys)
      ? value.anchorKeys
          .filter((key) => typeof key === "string")
          .map((key) => key.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (!Number.isFinite(value.startScrollY) || value.startScrollY < 0 || anchorKeys.length === 0) {
      return null;
    }
    return Object.freeze({
      startScrollY: Math.trunc(value.startScrollY),
      anchorKeys: Object.freeze(anchorKeys),
      settleMs: clampInteger(value.settleMs, 100, limits.maxScrollSettleMs, 900),
    });
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  }

  function clampNumber(value, minimum, maximum, fallback) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(minimum, Math.min(maximum, value))
      : fallback;
  }

  globalThis.AkuBoundedCapturePolicy = Object.freeze({
    limits,
    normalizeCapturePlan,
    countNewCandidates,
    hasChangedVisibleFeed,
    platformIdFromCandidates,
    normalizeMediaCandidates,
    findXHlsMasterUrl,
    xPlaybackRank,
    mediaUrlFromCssBackground,
  });
})();
