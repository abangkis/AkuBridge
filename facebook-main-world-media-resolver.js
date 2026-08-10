// This function is intentionally self-contained so Chrome can serialize it into the MAIN world.
// It parses only bounded Facebook JSON data and returns post IDs plus allowlisted media evidence.
export function resolveFacebookStructuredMediaInMainWorld(request = {}) {
  const runtimeRevision = "facebook-main-world-media-resolver-v1";
  const maxCandidates = clamp(request.maxCandidates, 1, 24, 16);
  const maxScripts = clamp(request.maxScripts, 1, 48, 32);
  const maxScriptBytes = clamp(request.maxScriptBytes, 8_192, 512_000, 256_000);
  const maxTotalBytes = clamp(request.maxTotalBytes, 64_000, 4_000_000, 2_000_000);
  const maxTraversalNodes = clamp(request.maxTraversalNodes, 500, 40_000, 20_000);
  const maxDepth = clamp(request.maxDepth, 8, 48, 40);
  const requestedIds = new Set(
    (Array.isArray(request.candidateIds) ? request.candidateIds : [])
      .map(normalizeCandidateId)
      .filter(Boolean)
      .slice(0, maxCandidates),
  );
  const candidates = new Map();
  let inspectedScriptCount = 0;
  let parsedScriptCount = 0;
  let rejectedScriptCount = 0;
  let inspectedBytes = 0;
  let traversedNodeCount = 0;
  let matchedMediaObjectCount = 0;

  const scripts = [...(globalThis.document?.querySelectorAll?.(
    'script[type="application/json"][data-sjs]',
  ) ?? [])].slice(0, maxScripts);
  for (const script of scripts) {
    if (candidates.size >= maxCandidates || traversedNodeCount >= maxTraversalNodes) break;
    const text = typeof script?.textContent === "string" ? script.textContent : "";
    if (!text || text.length > maxScriptBytes || inspectedBytes + text.length > maxTotalBytes) {
      if (text) rejectedScriptCount += 1;
      continue;
    }
    if (!/(?:progressive_urls|videoDeliveryResponseResult|browser_native_(?:hd|sd)_url)/i.test(text)) {
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

    const seen = new Set();
    const queue = [{ value: root, depth: 0 }];
    while (
      queue.length > 0 &&
      traversedNodeCount < maxTraversalNodes &&
      candidates.size < maxCandidates
    ) {
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      traversedNodeCount += 1;

      const media = mediaFromObject(value);
      if (media) {
        matchedMediaObjectCount += 1;
        const candidateId = candidateIdFromMediaObject(value);
        if (candidateId && (requestedIds.size === 0 || requestedIds.has(candidateId))) {
          const existing = candidates.get(candidateId);
          if (!existing || mediaScore(media) >= mediaScore(existing.media[0])) {
            candidates.set(candidateId, { candidateId, media: [media] });
          }
        }
      }

      if (current.depth >= maxDepth) continue;
      for (const child of dataValues(value, 160)) {
        if (isObject(child) && !seen.has(child)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
  }

  return Object.freeze({
    runtimeRevision,
    resolverVersion: "facebook-structured-video-v1",
    candidates: [...candidates.values()],
    diagnostics: Object.freeze({
      scriptCount: scripts.length,
      inspectedScriptCount,
      parsedScriptCount,
      rejectedScriptCount,
      inspectedBytes,
      traversedNodeCount,
      matchedMediaObjectCount,
      candidateCount: candidates.size,
      bounded: traversedNodeCount >= maxTraversalNodes || inspectedBytes >= maxTotalBytes,
    }),
  });

  function mediaFromObject(value) {
    const deliveryFragment = dataProperty(value, "videoDeliveryResponseFragment");
    const deliveryResult = dataProperty(deliveryFragment, "videoDeliveryResponseResult");
    const progressive = dataProperty(deliveryResult, "progressive_urls");
    const legacy = dataProperty(value, "videoDeliveryLegacyFields");
    const playbackCandidates = [];
    for (const entry of Array.isArray(progressive) ? progressive.slice(0, 8) : []) {
      playbackCandidates.push(dataProperty(entry, "progressive_url"));
    }
    playbackCandidates.push(
      dataProperty(legacy, "browser_native_hd_url"),
      dataProperty(legacy, "browser_native_sd_url"),
      dataProperty(value, "browser_native_hd_url"),
      dataProperty(value, "browser_native_sd_url"),
    );
    const validPlayback = playbackCandidates.map(safeFacebookVideoUrl).filter(Boolean);
    const playbackUrl = validPlayback.at(-1) ?? null;
    if (!playbackUrl) return null;

    const preferredThumbnail = dataProperty(value, "preferred_thumbnail");
    const preferredImage = dataProperty(preferredThumbnail, "image");
    const posterCandidates = [
      dataProperty(value, "first_frame_thumbnail"),
      dataProperty(preferredImage, "uri"),
      dataProperty(preferredThumbnail, "uri"),
      dataProperty(value, "thumbnail_url"),
    ];
    const posterUrl = posterCandidates.map(safeFacebookImageUrl).find(Boolean) ?? null;
    if (!posterUrl) return null;
    return {
      kind: "video",
      url: posterUrl,
      posterUrl,
      playbackUrl,
      playbackMode: "inline",
      width: positiveInteger(dataProperty(value, "width")),
      height: positiveInteger(dataProperty(value, "height")),
      provenance: "facebook_structured_json",
    };
  }

  function candidateIdFromMediaObject(value) {
    const candidates = [
      dataProperty(value, "id"),
      dataProperty(value, "permalink_url"),
      dataProperty(value, "shareable_url"),
    ];
    return candidates.map(normalizeCandidateId).find(Boolean) ?? null;
  }

  function normalizeCandidateId(value) {
    if (typeof value !== "string") return null;
    const direct = value.trim().match(/^facebook:post:(pfbid[A-Za-z0-9]+|\d{5,30})$/i);
    if (direct) return `facebook:post:${direct[1]}`;
    if (/^(?:pfbid[A-Za-z0-9]+|\d{5,30})$/i.test(value.trim())) {
      return `facebook:post:${value.trim()}`;
    }
    try {
      const url = new URL(value, "https://www.facebook.com/");
      if (!["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname.toLowerCase())) {
        return null;
      }
      const queryId = ["story_fbid", "fbid", "photo_id", "v"]
        .map((key) => url.searchParams.get(key))
        .find((entry) => /^(?:pfbid[A-Za-z0-9]+|\d{5,30})$/i.test(entry ?? ""));
      const pathId = url.pathname.match(
        /\/(?:posts|videos|reel)\/(pfbid[A-Za-z0-9]+|\d{5,30})(?:\/|$)/i,
      )?.[1];
      const id = queryId || pathId;
      return id ? `facebook:post:${id}` : null;
    } catch {
      return null;
    }
  }

  function safeFacebookVideoUrl(value) {
    const url = safeFacebookMediaUrl(value);
    if (!url || !/\.mp4$/i.test(new URL(url).pathname)) return null;
    return url;
  }

  function safeFacebookImageUrl(value) {
    const url = safeFacebookMediaUrl(value);
    if (!url || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname)) return null;
    return url;
  }

  function safeFacebookMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" || url.username || url.password || url.port ||
        !["fbcdn.net", "fbsbx.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
      ) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function mediaScore(media) {
    return positiveInteger(media?.width) * positiveInteger(media?.height);
  }

  function dataValues(value, limit) {
    const values = [];
    for (const key of ownNames(value, limit)) {
      const child = dataProperty(value, key);
      if (child !== undefined) values.push(child);
    }
    return values;
  }

  function ownNames(value, limit) {
    if (!isObject(value)) return [];
    try {
      return Object.getOwnPropertyNames(value).slice(0, limit);
    } catch {
      return [];
    }
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

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(8_192, Math.round(number)) : 0;
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }
}
