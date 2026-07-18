(() => {
  const runtimeRevision = "x-media-evidence-runtime-v3";
  const responseEvidenceRevision = "x-response-evidence-v2";
  if (
    globalThis.AkuXMediaEvidence?.runtimeRevision === runtimeRevision &&
    globalThis.AkuXMediaEvidenceRuntime?.runtimeRevision === runtimeRevision
  ) return;
  const defaults = Object.freeze({
    maxCandidates: 128,
    maxAvatarCandidates: 256,
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

  function createAvatarCache(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const maxCandidates = clampInteger(
      options.maxAvatarCandidates ?? options.maxCandidates,
      1,
      512,
      defaults.maxAvatarCandidates,
    );
    const ttlMs = clampInteger(options.ttlMs, 100, 24 * 60 * 60 * 1_000, defaults.ttlMs);
    const entries = new Map();
    const counters = { accepted: 0, rejected: 0, expired: 0, evicted: 0 };

    function put(candidateId, value) {
      const key = normalizeAvatarKey(candidateId);
      const url = safeXAvatarUrl(value);
      if (!key || !url) {
        counters.rejected += 1;
        return null;
      }
      purgeExpired();
      entries.delete(key);
      entries.set(key, { url, expiresAtMs: now() + ttlMs });
      counters.accepted += 1;
      while (entries.size > maxCandidates) {
        entries.delete(entries.keys().next().value);
        counters.evicted += 1;
      }
      return url;
    }

    function get(candidateId) {
      const key = normalizeAvatarKey(candidateId);
      if (!key) return null;
      purgeExpired();
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.url;
    }

    function purgeExpired() {
      const current = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs > current) continue;
        entries.delete(key);
        counters.expired += 1;
      }
    }

    function clear() {
      entries.clear();
    }

    function diagnostics() {
      purgeExpired();
      return Object.freeze({ candidateCount: entries.size, maxCandidates, ttlMs, ...counters });
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
    const avatarCache = options.avatarCache ?? createAvatarCache(options);
    const publish = typeof options.publish === "function" ? options.publish : publishEvidence;
    const publishAvatar = typeof options.publishAvatar === "function"
      ? options.publishAvatar
      : publishAvatarEvidence;
    const dirtyContainers = new Set();
    const lastPublished = new Map();
    let observer = null;
    let flushPending = false;
    const responseEvidence = {
      messagesReceived: 0,
      messagesRejected: 0,
      acceptedCandidateCount: 0,
      acceptedAvatarCandidateCount: 0,
      acceptedPersistentAvatarCount: 0,
      observedResponseCount: 0,
      parsedResponseCount: 0,
      rejectedResponseCount: 0,
      lastCandidateCount: 0,
      lastMediaCount: 0,
      lastAvatarCount: 0,
      lastTraversedNodeCount: 0,
      lastBounded: false,
    };

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

    function lookupAvatarContainer(container) {
      return avatarCache.get(candidateIdFromContainer(container)) ??
        avatarCache.get(avatarKeyFromContainer(container));
    }

    function lookupAvatar(candidateId) {
      return avatarCache.get(candidateId);
    }

    function ingestCandidates(payload, provenance) {
      const candidates = Array.isArray(payload) ? payload : payload?.candidates;
      let acceptedCandidateCount = 0;
      for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 24) : []) {
        if (!candidate || typeof candidate !== "object") continue;
        const stored = storeEvidence(candidate.candidateId, candidate.media, provenance);
        if (stored.length > 0) acceptedCandidateCount += 1;
      }
      return acceptedCandidateCount;
    }

    function ingestStructured(payload) {
      return ingestCandidates(payload, "main_structured_state");
    }

    function ingestResponseEvidence(payload) {
      responseEvidence.messagesReceived += 1;
      if (!validResponseEvidenceEnvelope(payload)) {
        responseEvidence.messagesRejected += 1;
        return 0;
      }
      const diagnostics = payload.diagnostics ?? {};
      responseEvidence.observedResponseCount = diagnostics.observedResponseCount ?? 0;
      responseEvidence.parsedResponseCount = diagnostics.parsedResponseCount ?? 0;
      responseEvidence.rejectedResponseCount = diagnostics.rejectedResponseCount ?? 0;
      responseEvidence.lastCandidateCount = diagnostics.candidateCount ?? 0;
      responseEvidence.lastMediaCount = diagnostics.mediaCount ?? 0;
      responseEvidence.lastAvatarCount = diagnostics.avatarCount ?? 0;
      responseEvidence.lastTraversedNodeCount = diagnostics.traversedNodeCount ?? 0;
      responseEvidence.lastBounded = diagnostics.bounded === true;
      const accepted = ingestCandidates(payload, "x_response_graphql");
      let acceptedAvatars = 0;
      for (const candidate of payload.candidates) {
        if (candidate.avatarUrl && avatarCache.put(candidate.candidateId, candidate.avatarUrl)) {
          acceptedAvatars += 1;
          if (candidate.avatarKey) avatarCache.put(candidate.avatarKey, candidate.avatarUrl);
          publishAvatar(
            [candidate.candidateId, candidate.avatarKey].filter(Boolean),
            candidate.avatarUrl,
          );
        }
      }
      responseEvidence.acceptedCandidateCount += accepted;
      responseEvidence.acceptedAvatarCandidateCount += acceptedAvatars;
      return accepted;
    }

    function avatarKeysForContainer(container) {
      const keys = [...new Set([
        candidateIdFromContainer(container),
        avatarKeyFromContainer(container),
      ].filter(Boolean))].slice(0, 2);
      return keys.some((key) => avatarCache.get(key)) ? [] : keys;
    }

    function ingestPersistentAvatarEvidence(payload) {
      const entries = Array.isArray(payload) ? payload : payload?.entries;
      let accepted = 0;
      for (const entry of Array.isArray(entries) ? entries.slice(0, 48) : []) {
        if (!entry || typeof entry !== "object") continue;
        if (avatarCache.put(entry.key, entry.url)) accepted += 1;
      }
      responseEvidence.acceptedPersistentAvatarCount += accepted;
      return accepted;
    }

    function responseDiagnostics() {
      return Object.freeze({
        runtimeRevision: responseEvidenceRevision,
        ...responseEvidence,
      });
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
      lookupAvatarContainer,
      lookupAvatar,
      avatarKeysForContainer,
      ingestPersistentAvatarEvidence,
      ingestStructured,
      ingestResponseEvidence,
      responseDiagnostics,
      diagnostics: cache.diagnostics,
      avatarDiagnostics: avatarCache.diagnostics,
    });
  }

  function installResponseEvidenceBridge(runtime, windowObject = globalThis.window) {
    if (
      !runtime ||
      globalThis.location?.origin !== "https://x.com" ||
      typeof windowObject?.addEventListener !== "function" ||
      typeof windowObject?.postMessage !== "function"
    ) return false;
    const priorHandler = globalThis.__akuXResponseEvidenceBridgeHandler;
    if (typeof priorHandler === "function" && typeof windowObject.removeEventListener === "function") {
      windowObject.removeEventListener("message", priorHandler);
    }
    const handler = (event) => {
      if (
        event.source !== windowObject ||
        event.origin !== "https://x.com" ||
        event.data?.type !== "AKU_X_RESPONSE_MEDIA_EVIDENCE"
      ) return;
      runtime.ingestResponseEvidence(event.data);
    };
    globalThis.__akuXResponseEvidenceBridgeHandler = handler;
    windowObject.addEventListener("message", handler);
    windowObject.postMessage({
      type: "AKU_X_RESPONSE_EVIDENCE_READY",
      runtimeRevision: responseEvidenceRevision,
    }, "https://x.com");
    return true;
  }

  function validResponseEvidenceEnvelope(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.runtimeRevision !== responseEvidenceRevision) return false;
    if (!hasOnlyKeys(payload, ["type", "runtimeRevision", "candidates", "diagnostics"])) return false;
    const candidates = payload.candidates;
    if (!Array.isArray(candidates) || candidates.length > 24) return false;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") return false;
      if (!hasOnlyKeys(candidate, ["candidateId", "media", "avatarUrl", "avatarKey"])) return false;
      if (!normalizeCandidateId(candidate.candidateId)) return false;
      if (candidate.avatarUrl !== undefined && !safeXAvatarUrl(candidate.avatarUrl)) return false;
      if (candidate.avatarKey !== undefined && (
        !candidate.avatarUrl || !normalizeAvatarKey(candidate.avatarKey)
      )) return false;
      if (!Array.isArray(candidate.media) || candidate.media.length > defaults.maxMediaPerCandidate) {
        return false;
      }
      for (const media of candidate.media) {
        if (!media || typeof media !== "object") return false;
        if (!hasOnlyKeys(media, [
          "kind", "url", "posterUrl", "playbackUrl", "playbackMode",
          "width", "height", "provenance",
        ])) return false;
      }
    }
    return validResponseDiagnostics(payload.diagnostics);
  }

  function validResponseDiagnostics(value) {
    if (value === undefined || value === null) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!hasOnlyKeys(value, [
      "observedResponseCount", "parsedResponseCount", "rejectedResponseCount",
      "candidateCount", "mediaCount", "avatarCount", "traversedNodeCount", "bounded",
    ])) return false;
    return Object.entries(value).every(([key, entry]) => (
      key === "bounded"
        ? typeof entry === "boolean"
        : Number.isInteger(entry) && entry >= 0 && entry <= 100_000
    ));
  }

  function hasOnlyKeys(value, allowed) {
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return false;
    }
    return keys.every((key) => allowed.includes(key));
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

  function avatarKeyFromContainer(container) {
    if (!container) return null;
    const roots = [
      container.querySelector?.('[data-testid="User-Name"]'),
      container.querySelector?.('[data-testid="Tweet-User-Avatar"]'),
    ].filter(Boolean);
    for (const root of roots) {
      for (const anchor of root.querySelectorAll?.("a[href]") ?? []) {
        if (insideQuotedPost(anchor, container)) continue;
        const key = normalizeAvatarKey(anchor.href ?? anchor.getAttribute?.("href"));
        if (key) return key;
      }
    }
    return null;
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

  function normalizeAvatarKey(value) {
    const candidateId = normalizeCandidateId(value);
    if (candidateId) return candidateId;
    if (typeof value !== "string") return null;
    const direct = value.trim().match(/^x:user:([A-Za-z0-9_]{1,15})$/i);
    if (direct) return `x:user:${direct[1].toLowerCase()}`;
    try {
      const url = new URL(value, "https://x.com/");
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "x.com" || url.username || url.password) {
        return null;
      }
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      return match ? `x:user:${match[1].toLowerCase()}` : null;
    } catch {
      return null;
    }
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
      provenance: ["main_structured_state", "x_response_graphql"].includes(provenance)
        ? provenance
        : "observed_dom",
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

  function safeXAvatarUrl(value) {
    const url = safeXMediaUrl(value);
    return url?.startsWith("https://pbs.twimg.com/profile_images/") ? url : null;
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

  function publishAvatarEvidence(keys, url) {
    if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") return;
    try {
      const pending = globalThis.chrome.runtime.sendMessage({
        type: "AKU_X_AVATAR_EVIDENCE_OBSERVED",
        keys,
        url,
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
    createAvatarCache,
    createRuntime,
    installResponseEvidenceBridge,
    validResponseEvidenceEnvelope,
    normalizeCandidateId,
    normalizeAvatarKey,
    candidateIdFromContainer,
    avatarKeyFromContainer,
    safeXMediaUrl,
    safeXAvatarUrl,
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
    installResponseEvidenceBridge(runtime);
  }
})();
