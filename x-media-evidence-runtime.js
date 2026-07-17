(() => {
  const runtimeRevision = "x-media-evidence-runtime-v1";
  if (
    globalThis.AkuXMediaEvidence?.runtimeRevision === runtimeRevision &&
    globalThis.AkuXMediaEvidenceRuntime?.runtimeRevision === runtimeRevision
  ) return;
  const defaults = Object.freeze({
    maxCandidates: 128,
    maxMediaPerCandidate: 4,
    ttlMs: 30 * 60 * 1_000,
    maxDirtyContainersPerFlush: 24,
  });
  const allowedPbsPaths = Object.freeze([
    "/media/",
    "/card_img/",
    "/ext_tw_video_thumb/",
    "/amplify_video_thumb/",
    "/tweet_video_thumb/",
    "/semantic_core_img/",
    "/profile_images/",
  ]);

  function createCache(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const maxCandidates = clampInteger(options.maxCandidates, 1, 512, defaults.maxCandidates);
    const maxMediaPerCandidate = clampInteger(
      options.maxMediaPerCandidate,
      1,
      8,
      defaults.maxMediaPerCandidate,
    );
    const ttlMs = clampInteger(options.ttlMs, 100, 24 * 60 * 60 * 1_000, defaults.ttlMs);
    const entries = new Map();
    const counters = {
      accepted: 0,
      rejected: 0,
      expired: 0,
      evicted: 0,
    };

    function put(candidateId, values, provenance = "observed_dom") {
      const key = normalizeCandidateId(candidateId);
      if (!key) return [];
      purgeExpired();
      const observedAtMs = now();
      const existing = entries.get(key);
      const media = new Map(existing?.media ?? []);
      for (const value of Array.isArray(values) ? values : []) {
        const normalized = normalizeMedia(value, provenance, observedAtMs);
        if (!normalized) {
          counters.rejected += 1;
          continue;
        }
        counters.accepted += 1;
        const identity = mediaIdentity(normalized);
        media.delete(identity);
        media.set(identity, normalized);
        while (media.size > maxMediaPerCandidate) media.delete(media.keys().next().value);
      }
      if (media.size === 0) return [];
      entries.delete(key);
      entries.set(key, {
        expiresAtMs: observedAtMs + ttlMs,
        media,
      });
      evictOverflow();
      return read(key, false);
    }

    function get(candidateId) {
      const key = normalizeCandidateId(candidateId);
      if (!key) return [];
      purgeExpired();
      return read(key, true);
    }

    function read(key, touch) {
      const entry = entries.get(key);
      if (!entry) return [];
      if (touch) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return [...entry.media.values()].map((value) => Object.freeze({ ...value }));
    }

    function purgeExpired() {
      const current = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs > current) continue;
        entries.delete(key);
        counters.expired += 1;
      }
    }

    function evictOverflow() {
      while (entries.size > maxCandidates) {
        entries.delete(entries.keys().next().value);
        counters.evicted += 1;
      }
    }

    function clear() {
      entries.clear();
    }

    function diagnostics() {
      purgeExpired();
      return Object.freeze({
        runtimeRevision,
        candidateCount: entries.size,
        maxCandidates,
        maxMediaPerCandidate,
        ttlMs,
        ...counters,
      });
    }

    return Object.freeze({ put, get, clear, diagnostics });
  }

  function createRuntime(options = {}) {
    const documentObject = options.document ?? globalThis.document;
    const MutationObserverConstructor = options.MutationObserver ?? globalThis.MutationObserver;
    const queue = typeof options.queueMicrotask === "function"
      ? options.queueMicrotask
      : globalThis.queueMicrotask?.bind(globalThis) ?? ((callback) => Promise.resolve().then(callback));
    const cache = options.cache ?? createCache(options);
    const publish = typeof options.publish === "function" ? options.publish : publishEvidence;
    const dirtyContainers = new Set();
    const lastPublished = new Map();
    let observer = null;
    let flushPending = false;

    function start() {
      if (observer || !documentObject || typeof MutationObserverConstructor !== "function") {
        return false;
      }
      observer = new MutationObserverConstructor((records) => {
        for (const record of Array.isArray(records) ? records : []) {
          markNode(record.target);
          for (const node of record.addedNodes ?? []) markNode(node);
        }
        scheduleFlush();
      });
      observer.observe(documentObject, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "src", "srcset", "poster", "style", "width", "height"],
      });
      for (const container of documentObject.querySelectorAll?.('article[data-testid="tweet"]') ?? []) {
        dirtyContainers.add(container);
      }
      scheduleFlush();
      return true;
    }

    function stop() {
      observer?.disconnect?.();
      observer = null;
      dirtyContainers.clear();
      flushPending = false;
    }

    function markNode(node) {
      if (!node || (node.nodeType !== undefined && node.nodeType !== 1)) return;
      const container = node.matches?.('article[data-testid="tweet"]')
        ? node
        : node.closest?.('article[data-testid="tweet"]');
      if (container) dirtyContainers.add(container);
      for (const nested of node.querySelectorAll?.('article[data-testid="tweet"]') ?? []) {
        dirtyContainers.add(nested);
      }
    }

    function scheduleFlush() {
      if (flushPending || dirtyContainers.size === 0) return;
      flushPending = true;
      queue(flush);
    }

    function flush() {
      flushPending = false;
      let handled = 0;
      for (const container of dirtyContainers) {
        dirtyContainers.delete(container);
        captureContainer(container);
        handled += 1;
        if (handled >= defaults.maxDirtyContainersPerFlush) break;
      }
      if (dirtyContainers.size > 0) scheduleFlush();
    }

    function captureContainer(container) {
      const candidateId = candidateIdFromContainer(container);
      if (!candidateId) return [];
      return storeEvidence(candidateId, mediaFromContainer(container), "observed_dom");
    }

    function lookupContainer(container) {
      return cache.get(candidateIdFromContainer(container));
    }

    function lookup(candidateId) {
      return cache.get(candidateId);
    }

    function ingestStructured(payload) {
      const candidates = Array.isArray(payload) ? payload : payload?.candidates;
      let acceptedCandidateCount = 0;
      for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 24) : []) {
        if (!candidate || typeof candidate !== "object") continue;
        const stored = storeEvidence(candidate.candidateId, candidate.media, "main_structured_state");
        if (stored.length > 0) acceptedCandidateCount += 1;
      }
      return acceptedCandidateCount;
    }

    function storeEvidence(candidateId, values, provenance) {
      const normalizedID = normalizeCandidateId(candidateId);
      if (!normalizedID) return [];
      const stored = cache.put(normalizedID, values, provenance);
      if (stored.length > 0 && Array.isArray(values) && values.length > 0) {
        const fingerprint = stored.map((value) => [
          mediaIdentity(value),
          value.width,
          value.height,
          value.provenance,
        ].join(":")).join(";");
        if (lastPublished.get(normalizedID) !== fingerprint) {
          lastPublished.delete(normalizedID);
          lastPublished.set(normalizedID, fingerprint);
          while (lastPublished.size > defaults.maxCandidates) {
            lastPublished.delete(lastPublished.keys().next().value);
          }
          publish(normalizedID, stored);
        }
      }
      return stored;
    }

    return Object.freeze({
      runtimeRevision,
      start,
      stop,
      captureContainer,
      lookupContainer,
      lookup,
      ingestStructured,
      diagnostics: cache.diagnostics,
    });
  }

  function candidateIdFromContainer(container) {
    if (!container) return null;
    const values = [];
    for (const time of container.querySelectorAll?.("time") ?? []) {
      if (insideQuotedPost(time, container)) continue;
      values.push(time.closest?.('a[href*="/status/"]')?.href);
    }
    for (const anchor of container.querySelectorAll?.('a[href*="/status/"]') ?? []) {
      if (insideQuotedPost(anchor, container)) continue;
      values.push(anchor.href, anchor.getAttribute?.("href"));
    }
    return values.map(normalizeCandidateId).find(Boolean) ?? null;
  }

  function insideQuotedPost(element, container) {
    const quoted = element?.closest?.('[data-testid="quoteTweet"]');
    return Boolean(quoted && quoted !== container);
  }

  function mediaFromContainer(container) {
    const roots = uniqueElements([
      ...(container.querySelectorAll?.('[data-testid="tweetPhoto"]') ?? []),
      ...(container.querySelectorAll?.('[data-testid="previewInterstitial"]') ?? []),
      ...(container.querySelectorAll?.('[data-testid="videoPlayer"]') ?? []),
      ...(container.querySelectorAll?.('[data-testid="videoComponent"]') ?? []),
      ...(container.querySelectorAll?.('a[href*="/status/"][href*="/photo/"]') ?? []),
      ...(container.querySelectorAll?.('a[aria-label][href] img[src*="/card_img/"]') ?? []),
    ]).filter((root) => !insideQuotedPost(root, container));
    const values = [];
    for (const root of roots) {
      const kind = root.matches?.(
        '[data-testid="previewInterstitial"], [data-testid="videoPlayer"], '
          + '[data-testid="videoComponent"]',
      ) || root.closest?.(
        '[data-testid="previewInterstitial"], [data-testid="videoPlayer"], '
          + '[data-testid="videoComponent"]',
      ) ? "video" : "image";
      const elements = uniqueElements([
        root,
        ...(root.querySelectorAll?.("img, video, source, [style]") ?? []),
      ]);
      for (const element of elements) {
        for (const url of elementUrls(element)) {
          values.push(mediaValue(url, element, kind));
        }
      }
    }
    return values;
  }

  function elementUrls(element) {
    const values = [
      element?.currentSrc,
      element?.src,
      element?.poster,
      element?.getAttribute?.("src"),
      element?.getAttribute?.("poster"),
      ...srcsetUrls(element?.srcset),
      ...srcsetUrls(element?.getAttribute?.("srcset")),
      cssUrl(element?.style?.backgroundImage),
      cssUrl(element?.getAttribute?.("style")),
    ];
    return [...new Set(values.filter(Boolean))];
  }

  function mediaValue(url, element, kind) {
    const width = firstPositiveInteger(
      element?.naturalWidth,
      element?.videoWidth,
      element?.width,
      element?.getAttribute?.("width"),
    );
    const height = firstPositiveInteger(
      element?.naturalHeight,
      element?.videoHeight,
      element?.height,
      element?.getAttribute?.("height"),
    );
    return {
      kind,
      url,
      posterUrl: kind === "video" && String(url).includes("pbs.twimg.com") ? url : null,
      playbackUrl: kind === "video" && String(url).includes("video.twimg.com") ? url : null,
      width,
      height,
    };
  }

  function normalizeCandidateId(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/(?:^x:status:|\/status\/)(\d{5,30})(?:\b|\/|\?|#|$)/i);
    return match ? `x:status:${match[1]}` : null;
  }

  function normalizeMedia(value, provenance, observedAtMs) {
    if (!value || typeof value !== "object") return null;
    const primary = safeXMediaUrl(value.posterUrl || value.url);
    const playbackUrl = safeXMediaUrl(value.playbackUrl);
    if (!primary && !playbackUrl) return null;
    const primaryUrl = primary ?? playbackUrl;
    const kind = value.kind === "video" || playbackUrl?.startsWith("https://video.twimg.com/")
      ? "video"
      : primaryUrl.includes("/profile_images/")
        ? "avatar"
        : "image";
    return Object.freeze({
      kind,
      url: primaryUrl,
      posterUrl: kind === "video" && primary?.startsWith("https://pbs.twimg.com/") ? primary : null,
      playbackUrl: kind === "video" && playbackUrl?.startsWith("https://video.twimg.com/")
        ? playbackUrl
        : null,
      playbackMode: kind === "video" && playbackUrl ? "inline" : kind === "video" ? "native" : null,
      alt: typeof value.alt === "string" ? value.alt.trim().slice(0, 300) : "",
      width: clampInteger(value.width, 0, 8_192, 0),
      height: clampInteger(value.height, 0, 8_192, 0),
      provenance: provenance === "main_structured_state" ? provenance : "observed_dom",
      observedAtMs,
    });
  }

  function safeXMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (host === "pbs.twimg.com") {
        if (!allowedPbsPaths.some((prefix) => url.pathname.startsWith(prefix))) return null;
      } else if (host === "video.twimg.com") {
        if (!/^\/(?:amplify_video|ext_tw_video|tweet_video)\//.test(url.pathname)) return null;
      } else {
        return null;
      }
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function mediaIdentity(value) {
    return [
      value.kind,
      xAssetIdentity(value.url),
      xAssetIdentity(value.playbackUrl),
    ].join("|");
  }

  function xAssetIdentity(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      url.hash = "";
      if (url.hostname.toLowerCase() === "pbs.twimg.com") url.searchParams.delete("name");
      url.searchParams.sort();
      return url.href;
    } catch {
      return value;
    }
  }

  function publishEvidence(candidateId, media) {
    if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") return;
    try {
      const pending = globalThis.chrome.runtime.sendMessage({
        type: "AKU_X_MEDIA_EVIDENCE_OBSERVED",
        candidateId,
        media,
      });
      pending?.catch?.(() => undefined);
    } catch {
      // Extension reloads and page teardown may invalidate the message port.
    }
  }

  function srcsetUrls(value) {
    if (typeof value !== "string") return [];
    return value.split(",")
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function cssUrl(value) {
    if (typeof value !== "string") return null;
    return value.match(/url\((?:["']?)(https:\/\/[^"')]+)(?:["']?)\)/i)?.[1] ?? null;
  }

  function firstPositiveInteger(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return Math.round(number);
    }
    return 0;
  }

  function uniqueElements(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  const api = Object.freeze({
    runtimeRevision,
    defaults,
    createCache,
    createRuntime,
    normalizeCandidateId,
    candidateIdFromContainer,
    safeXMediaUrl,
  });
  globalThis.AkuXMediaEvidence = api;

  if (
    globalThis.location?.hostname === "x.com" &&
    globalThis.document &&
    typeof globalThis.MutationObserver === "function"
  ) {
    globalThis.AkuXMediaEvidenceRuntime?.stop?.();
    const runtime = createRuntime();
    globalThis.AkuXMediaEvidenceRuntime = runtime;
    runtime.start();
  }
})();
