// This installer is intentionally self-contained so the manifest can run it in the MAIN
// world at document_start. Raw GraphQL responses never cross the world boundary.
function installXResponseEvidenceAdapterInMainWorld(configuration = {}) {
  const RUNTIME_REVISION = "x-response-evidence-v2";
  const EVIDENCE_EVENT = "AKU_X_RESPONSE_MEDIA_EVIDENCE";
  const READY_EVENT = "AKU_X_RESPONSE_EVIDENCE_READY";
  const GLOBAL_KEY = "__akuXResponseEvidenceAdapterV2";
  const MAX_MEDIA_PER_CANDIDATE = 4;
  const maxBodyBytes = clamp(configuration.maxBodyBytes, 16_384, 4_194_304, 2_097_152);
  const maxTraversalNodes = clamp(configuration.maxTraversalNodes, 100, 20_000, 5_000);
  const maxDepth = clamp(configuration.maxDepth, 3, 20, 12);
  const maxProperties = clamp(configuration.maxProperties, 8, 200, 100);
  const maxCandidatesPerResponse = clamp(configuration.maxCandidatesPerResponse, 1, 24, 24);
  const maxCandidatesPerPayload = Math.max(
    maxCandidatesPerResponse,
    clamp(configuration.maxCandidatesPerPayload, 1, 128, 96),
  );
  const maxCachedCandidates = clamp(configuration.maxCachedCandidates, 1, 128, 64);
  let pageLocation = null;
  let pageHref = "";
  try {
    pageLocation = globalThis.location;
    pageHref = String(pageLocation?.href ?? "");
  } catch {
    // A document without readable location state is outside the adapter contract.
  }

  const existing = dataProperty(globalThis, GLOBAL_KEY);
  if (existing?.runtimeRevision === RUNTIME_REVISION) return existing;

  if (!isExactXPage(pageLocation)) {
    return Object.freeze({ runtimeRevision: RUNTIME_REVISION, installed: false });
  }

  const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch : null;
  const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
  const originalXHROpen = typeof xhrPrototype?.open === "function" ? xhrPrototype.open : null;
  const originalXHRSend = typeof xhrPrototype?.send === "function" ? xhrPrototype.send : null;
  const originalXHRAddEventListener = typeof xhrPrototype?.addEventListener === "function"
    ? xhrPrototype.addEventListener
    : null;
  const originalResponseClone = globalThis.Response?.prototype?.clone;
  const originalResponseText = globalThis.Response?.prototype?.text;
  const responseURLGetter = ownGetter(globalThis.Response?.prototype, "url");
  const responseStatusGetter = ownGetter(globalThis.Response?.prototype, "status");
  const responseHeadersGetter = ownGetter(globalThis.Response?.prototype, "headers");
  const responseBodyGetter = ownGetter(globalThis.Response?.prototype, "body");
  const originalHeadersGet = globalThis.Headers?.prototype?.get;
  const originalStreamGetReader = globalThis.ReadableStream?.prototype?.getReader;
  const originalReaderRead = globalThis.ReadableStreamDefaultReader?.prototype?.read;
  const originalReaderCancel = globalThis.ReadableStreamDefaultReader?.prototype?.cancel;
  const windowObject = globalThis.window;
  const nativeAddEventListener = globalThis.addEventListener;
  const nativeRemoveEventListener = globalThis.removeEventListener;
  const nativePostMessage = windowObject?.postMessage;
  const xhrMetadata = new WeakMap();
  const cache = new Map();
  const counters = {
    observedResponseCount: 0,
    parsedResponseCount: 0,
    rejectedResponseCount: 0,
  };
  let stopped = false;

  function emit(candidates, diagnostics = {}) {
    if (stopped || typeof nativePostMessage !== "function") return;
    const safeCandidates = sanitizeCandidateBatch(candidates, maxCandidatesPerResponse);
    const mediaCount = safeCandidates.reduce((sum, candidate) => sum + candidate.media.length, 0);
    const avatarCount = safeCandidates.reduce((sum, candidate) => sum + (candidate.avatarUrl ? 1 : 0), 0);
    const message = Object.freeze({
      type: EVIDENCE_EVENT,
      runtimeRevision: RUNTIME_REVISION,
      candidates: safeCandidates,
      diagnostics: Object.freeze({
        observedResponseCount: clamp(counters.observedResponseCount, 0, 100_000, 0),
        parsedResponseCount: clamp(counters.parsedResponseCount, 0, 100_000, 0),
        rejectedResponseCount: clamp(counters.rejectedResponseCount, 0, 100_000, 0),
        candidateCount: safeCandidates.length,
        mediaCount,
        avatarCount,
        traversedNodeCount: clamp(diagnostics.traversedNodeCount, 0, maxTraversalNodes, 0),
        bounded: diagnostics.bounded === true,
      }),
    });
    try {
      nativePostMessage.call(windowObject, message, "https://x.com");
    } catch {
      // Evidence is optional; capture must continue if the cross-world event cannot be sent.
    }
  }

  function retainAndEmit(candidates, diagnostics) {
    const safeCandidates = sanitizeCandidateBatch(candidates, maxCandidatesPerPayload);
    for (const candidate of safeCandidates) {
      const cached = cache.get(candidate.candidateId);
      const prior = cached?.media ?? [];
      const merged = sanitizeMedia([...candidate.media, ...prior]);
      const avatarUrl = safeXAvatarURL(candidate.avatarUrl) ?? cached?.avatarUrl ?? null;
      cache.delete(candidate.candidateId);
      cache.set(candidate.candidateId, Object.freeze({
        candidateId: candidate.candidateId,
        media: merged,
        ...(avatarUrl ? { avatarUrl } : {}),
      }));
    }
    while (cache.size > maxCachedCandidates) cache.delete(cache.keys().next().value);
    if (safeCandidates.length === 0) {
      emit([], diagnostics);
      return;
    }
    for (let offset = 0; offset < safeCandidates.length; offset += maxCandidatesPerResponse) {
      emit(safeCandidates.slice(offset, offset + maxCandidatesPerResponse), diagnostics);
    }
  }

  function replay() {
    const values = [...cache.values()];
    for (let offset = 0; offset < values.length; offset += maxCandidatesPerResponse) {
      emit(values.slice(offset, offset + maxCandidatesPerResponse));
    }
  }

  function inspectPayload(payload) {
    try {
      const result = extractCandidates(payload);
      counters.parsedResponseCount += 1;
      retainAndEmit(result.candidates, result.diagnostics);
    } catch {
      // Malformed or hostile response objects are ignored.
      counters.rejectedResponseCount += 1;
      emit([]);
    }
  }

  async function inspectFetchResponse(response) {
    try {
      const url = responseURLGetter?.call(response) || dataProperty(response, "url");
      const status = responseStatusGetter?.call(response);
      if (!allowedOperationURL(url) || !successfulStatus(status)) return;
      counters.observedResponseCount += 1;
      const headers = responseHeadersGetter?.call(response);
      const contentType = typeof originalHeadersGet === "function"
        ? originalHeadersGet.call(headers, "content-type")
        : null;
      if (typeof contentType !== "string" || !/(?:^|[+/])json(?:;|$)/i.test(contentType)) {
        counters.rejectedResponseCount += 1;
        emit([]);
        return;
      }
      const contentLength = typeof originalHeadersGet === "function"
        ? Number(originalHeadersGet.call(headers, "content-length"))
        : 0;
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        counters.rejectedResponseCount += 1;
        emit([]);
        return;
      }
      if (typeof originalResponseClone !== "function") {
        counters.rejectedResponseCount += 1;
        emit([]);
        return;
      }
      const clone = originalResponseClone.call(response);
      const text = await readBoundedResponseText(clone);
      if (text === null) {
        counters.rejectedResponseCount += 1;
        emit([]);
        return;
      }
      inspectPayload(JSON.parse(text));
    } catch {
      // Reading the clone must never affect the page's response.
      counters.rejectedResponseCount += 1;
      emit([]);
    }
  }

  async function readBoundedResponseText(response) {
    try {
      const body = responseBodyGetter?.call(response);
      if (body && typeof originalStreamGetReader === "function" && typeof originalReaderRead === "function") {
        const reader = originalStreamGetReader.call(body);
        const chunks = [];
        let total = 0;
        while (true) {
          const state = await originalReaderRead.call(reader);
          if (state?.done) break;
          const chunk = state?.value;
          if (!(chunk instanceof Uint8Array)) return null;
          total += chunk.byteLength;
          if (total > maxBodyBytes) {
            try {
              const cancellation = originalReaderCancel?.call(reader);
              cancellation?.catch?.(() => undefined);
            } catch { /* ignore */ }
            return null;
          }
          chunks.push(chunk);
        }
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder().decode(joined);
      }
      if (typeof originalResponseText !== "function") return null;
      const text = await originalResponseText.call(response);
      return typeof text === "string" && new TextEncoder().encode(text).byteLength <= maxBodyBytes
        ? text
        : null;
    } catch {
      return null;
    }
  }

  function wrappedFetch(...args) {
    const result = originalFetch.apply(this, args);
    Promise.resolve(result).then(inspectFetchResponse).catch(() => undefined);
    return result;
  }

  function wrappedXHROpen(...args) {
    try {
      xhrMetadata.set(this, { allowed: allowedOperationURL(args[1]) });
    } catch {
      // Metadata is optional and must not change native open behavior.
    }
    return originalXHROpen.apply(this, args);
  }

  function wrappedXHRSend(...args) {
    const xhr = this;
    if (xhrMetadata.get(xhr)?.allowed && typeof originalXHRAddEventListener === "function") {
      try {
        originalXHRAddEventListener.call(xhr, "loadend", () => {
          try {
            if (!successfulStatus(Number(xhr.status)) || !allowedOperationURL(xhr.responseURL)) return;
            counters.observedResponseCount += 1;
            const responseType = String(xhr.responseType ?? "");
            if (responseType === "json") {
              inspectPayload(xhr.response);
              return;
            }
            if (responseType !== "" && responseType !== "text") {
              counters.rejectedResponseCount += 1;
              emit([]);
              return;
            }
            const text = xhr.responseText;
            if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > maxBodyBytes) {
              counters.rejectedResponseCount += 1;
              emit([]);
              return;
            }
            inspectPayload(JSON.parse(text));
          } catch {
            // XHR access can throw for invalid states or unusual response types.
            counters.rejectedResponseCount += 1;
            emit([]);
          }
        }, { once: true });
      } catch {
        // Listener attachment is failure-soft.
      }
    }
    return originalXHRSend.apply(xhr, args);
  }

  function extractCandidates(root) {
    const queue = [{ value: root, depth: 0 }];
    const seen = new Set();
    const candidates = [];
    const candidateIds = new Set();
    let traversedNodeCount = 0;
    let bounded = false;
    while (queue.length > 0) {
      if (traversedNodeCount >= maxTraversalNodes || candidates.length >= maxCandidatesPerPayload) {
        bounded = queue.length > 0;
        break;
      }
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      traversedNodeCount += 1;
      const tweetId = explicitTweetId(value);
      if (tweetId && !candidateIds.has(tweetId)) {
        const media = mediaForTweet(value, tweetId);
        const avatar = avatarForTweet(value);
        const avatarUrl = avatar?.url ?? null;
        if (media.length > 0 || avatarUrl) {
          candidateIds.add(tweetId);
          candidates.push(Object.freeze({
            candidateId: `x:status:${tweetId}`,
            media,
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(avatar?.key ? { avatarKey: avatar.key } : {}),
          }));
        }
      }
      const children = dataValues(value, maxProperties);
      if (current.depth >= maxDepth) {
        if (children.some(isObject)) bounded = true;
        continue;
      }
      for (const child of children) {
        if (isObject(child) && !seen.has(child)) queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    return {
      candidates,
      diagnostics: { traversedNodeCount, bounded },
    };
  }

  function mediaForTweet(tweet, tweetId) {
    const queue = [{ value: tweet, depth: 0 }];
    const seen = new Set();
    const media = [];
    let visited = 0;
    while (queue.length > 0 && visited < 1_000 && media.length < MAX_MEDIA_PER_CANDIDATE) {
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      const nestedTweetId = explicitTweetId(value);
      if (current.depth > 0 && nestedTweetId && nestedTweetId !== tweetId) continue;
      if (looksLikeMediaEntity(value)) {
        const item = mediaFromEntity(value);
        if (item) media.push(item);
      }
      if (current.depth >= 8) continue;
      for (const child of dataValues(value, maxProperties)) {
        if (isObject(child) && !seen.has(child)) queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    return sanitizeMedia(media);
  }

  function avatarForTweet(tweet) {
    const core = dataProperty(tweet, "core");
    const userResults = dataProperty(core, "user_results");
    let user = dataProperty(userResults, "result");
    for (let depth = 0; depth < 2; depth += 1) {
      const nested = dataProperty(user, "result");
      if (!isObject(nested)) break;
      user = nested;
    }
    const avatar = dataProperty(user, "avatar");
    const legacy = dataProperty(user, "legacy");
    const userCore = dataProperty(user, "core");
    const url = safeXAvatarURL(dataProperty(avatar, "image_url")) ??
      safeXAvatarURL(dataProperty(legacy, "profile_image_url_https"));
    if (!url) return null;
    const key = normalizeAvatarKey(
      dataProperty(userCore, "screen_name") ?? dataProperty(legacy, "screen_name"),
    );
    return Object.freeze({ url, ...(key ? { key } : {}) });
  }

  function mediaFromEntity(entity) {
    const posterUrl = safeXMediaURL(
      dataProperty(entity, "media_url_https") ?? dataProperty(entity, "media_url") ?? dataProperty(entity, "url"),
    );
    const originalInfo = dataProperty(entity, "original_info");
    const width = positiveInteger(dataProperty(originalInfo, "width") ?? dataProperty(entity, "width"));
    const height = positiveInteger(dataProperty(originalInfo, "height") ?? dataProperty(entity, "height"));
    let playbackUrl = null;
    let bestBitrate = -1;
    const videoInfo = dataProperty(entity, "video_info");
    const variants = dataProperty(videoInfo, "variants");
    for (const variant of Array.isArray(variants) ? variants.slice(0, 32) : []) {
      const contentType = dataProperty(variant, "content_type");
      const candidate = safeXMediaURL(dataProperty(variant, "url"));
      const bitrate = positiveInteger(dataProperty(variant, "bitrate"));
      if (contentType === "video/mp4" && candidate?.startsWith("https://video.twimg.com/") && bitrate >= bestBitrate) {
        playbackUrl = candidate;
        bestBitrate = bitrate;
      }
    }
    const kind = playbackUrl ? "video" : "image";
    if (!posterUrl?.startsWith("https://pbs.twimg.com/")) return null;
    return Object.freeze({
      kind,
      url: posterUrl,
      posterUrl: kind === "video" ? posterUrl : posterUrl,
      playbackUrl,
      width,
      height,
      provenance: "x_response_graphql",
    });
  }

  function sanitizeCandidateBatch(values, maximum) {
    const output = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const candidateId = normalizeCandidateId(dataProperty(value, "candidateId"));
      const media = sanitizeMedia(dataProperty(value, "media"));
      const avatarUrl = safeXAvatarURL(dataProperty(value, "avatarUrl"));
      const avatarKey = avatarUrl ? normalizeAvatarKey(dataProperty(value, "avatarKey")) : null;
      if (!candidateId || (media.length === 0 && !avatarUrl) || seen.has(candidateId)) continue;
      seen.add(candidateId);
      output.push(Object.freeze({
        candidateId,
        media,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(avatarKey ? { avatarKey } : {}),
      }));
      if (output.length >= maximum) break;
    }
    return Object.freeze(output);
  }

  function sanitizeMedia(values) {
    const output = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const posterUrl = safeXMediaURL(dataProperty(value, "posterUrl") ?? dataProperty(value, "url"));
      const playbackUrl = safeXMediaURL(dataProperty(value, "playbackUrl"));
      if (!posterUrl?.startsWith("https://pbs.twimg.com/")) continue;
      const kind = playbackUrl?.startsWith("https://video.twimg.com/") ? "video" : "image";
      const identity = `${assetIdentity(posterUrl)}|${assetIdentity(playbackUrl)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      output.push(Object.freeze({
        kind,
        url: posterUrl,
        posterUrl,
        playbackUrl: kind === "video" ? playbackUrl : null,
        width: positiveInteger(dataProperty(value, "width")),
        height: positiveInteger(dataProperty(value, "height")),
        provenance: "x_response_graphql",
      }));
      if (output.length >= MAX_MEDIA_PER_CANDIDATE) break;
    }
    return Object.freeze(output);
  }

  function looksLikeMediaEntity(value) {
    const type = dataProperty(value, "type");
    const directURL = safeXMediaURL(dataProperty(value, "url"));
    return type === "photo" || type === "video" || type === "animated_gif" ||
      typeof dataProperty(value, "media_url_https") === "string" &&
      (isObject(dataProperty(value, "original_info")) || isObject(dataProperty(value, "video_info"))) ||
      directURL?.startsWith("https://pbs.twimg.com/card_img/");
  }

  function explicitTweetId(value) {
    if (!isObject(value)) return null;
    const typeName = dataProperty(value, "__typename");
    const legacy = dataProperty(value, "legacy");
    const tweetShaped = typeof typeName === "string" && /^Tweet(?:WithVisibilityResults)?$/i.test(typeName) ||
      isObject(legacy) && (
        typeof dataProperty(legacy, "full_text") === "string" ||
        isObject(dataProperty(legacy, "extended_entities"))
      );
    if (!tweetShaped) return null;
    return numericIdentifier(dataProperty(value, "rest_id") ?? dataProperty(value, "id_str"));
  }

  function allowedOperationURL(value) {
    if (typeof value !== "string" && !(value instanceof URL)) return false;
    try {
      const url = new URL(value, pageHref);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "x.com" || url.username || url.password) return false;
      return /^\/(?:i\/)?api\/graphql\/[^/]+\/(?:HomeTimeline|HomeLatestTimeline|TweetDetail)$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isExactXPage(locationValue) {
    try {
      return String(locationValue?.protocol).toLowerCase() === "https:" &&
        String(locationValue?.hostname).toLowerCase() === "x.com";
    } catch {
      return false;
    }
  }

  function safeXMediaURL(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (host === "pbs.twimg.com") {
        if (!/^\/(?:media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|semantic_core_img)\//.test(url.pathname)) return null;
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

  function safeXAvatarURL(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hostname.toLowerCase() !== "pbs.twimg.com" ||
        !url.pathname.startsWith("/profile_images/")
      ) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function assetIdentity(value) {
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
      return "";
    }
  }

  function normalizeCandidateId(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^x:status:(\d{5,30})$/);
    return match ? `x:status:${match[1]}` : null;
  }

  function normalizeAvatarKey(value) {
    if (typeof value !== "string") return null;
    const match = value.trim().match(/^(?:x:user:|@)?([A-Za-z0-9_]{1,15})$/i);
    return match ? `x:user:${match[1].toLowerCase()}` : null;
  }

  function successfulStatus(value) {
    return Number.isFinite(value) && value >= 200 && value < 300;
  }

  function numericIdentifier(value) {
    if (typeof value === "string" && /^\d{5,30}$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      const normalized = String(value);
      return /^\d{5,30}$/.test(normalized) ? normalized : null;
    }
    return null;
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(8_192, Math.trunc(number)) : 0;
  }

  function dataValues(value, maximum) {
    const output = [];
    for (const key of ownNames(value, maximum)) {
      const child = dataProperty(value, key);
      if (child !== undefined) output.push(child);
    }
    return output;
  }

  function ownNames(value, maximum) {
    if (!isObject(value)) return [];
    try { return Object.getOwnPropertyNames(value).slice(0, maximum); } catch { return []; }
  }

  function dataProperty(value, key) {
    if (!isObject(value)) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }

  function ownGetter(value, key) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof descriptor?.get === "function" ? descriptor.get : null;
    } catch {
      return null;
    }
  }

  function isObject(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function readyListener(event) {
    if (
      event?.source !== windowObject ||
      event?.origin !== "https://x.com" ||
      dataProperty(event?.data, "type") !== READY_EVENT ||
      dataProperty(event?.data, "runtimeRevision") !== RUNTIME_REVISION
    ) return;
    replay();
  }
  if (typeof nativeAddEventListener === "function") {
    try { nativeAddEventListener.call(globalThis, "message", readyListener); } catch { /* ignore */ }
  }
  if (originalFetch) globalThis.fetch = wrappedFetch;
  if (originalXHROpen && originalXHRSend) {
    xhrPrototype.open = wrappedXHROpen;
    xhrPrototype.send = wrappedXHRSend;
  }

  const controller = Object.freeze({
    runtimeRevision: RUNTIME_REVISION,
    installed: true,
    replay,
    uninstall() {
      if (stopped) return;
      stopped = true;
      if (originalFetch && globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
      if (originalXHROpen && xhrPrototype.open === wrappedXHROpen) xhrPrototype.open = originalXHROpen;
      if (originalXHRSend && xhrPrototype.send === wrappedXHRSend) xhrPrototype.send = originalXHRSend;
      if (typeof nativeRemoveEventListener === "function") {
        try { nativeRemoveEventListener.call(globalThis, "message", readyListener); } catch { /* ignore */ }
      }
      try {
        if (dataProperty(globalThis, GLOBAL_KEY) === controller) delete globalThis[GLOBAL_KEY];
      } catch { /* ignore */ }
    },
  });
  try {
    Object.defineProperty(globalThis, GLOBAL_KEY, { configurable: true, value: controller });
  } catch {
    // The adapter still works if a hostile page prevents publishing the idempotence marker.
  }
  return controller;
}

// Manifest content scripts are classic scripts. Install immediately in MAIN at
// document_start, while exposing the installer only as a deterministic test hook.
try {
  Object.defineProperty(globalThis, "__akuInstallXResponseEvidenceAdapterInMainWorld", {
    configurable: true,
    value: installXResponseEvidenceAdapterInMainWorld,
  });
} catch {
  // Installation remains failure-soft if the page blocks the helper marker.
}
installXResponseEvidenceAdapterInMainWorld();
