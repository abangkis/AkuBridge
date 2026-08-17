// This function is intentionally self-contained so Chrome can serialize it into the MAIN world.
// It parses only bounded Instagram JSON data and returns shortcodes plus allowlisted media evidence.
export function resolveInstagramStructuredMediaInMainWorld(request = {}) {
  const runtimeRevision = "instagram-main-world-media-resolver-v2";
  const maxCandidates = clamp(request.maxCandidates, 1, 24, 16);
  const maxMediaPerCandidate = clamp(request.maxMediaPerCandidate, 1, 20, 20);
  const maxScripts = clamp(request.maxScripts, 1, 64, 48);
  const maxDocumentScripts = clamp(request.maxDocumentScripts, 1, 128, 96);
  const maxScriptBytes = clamp(request.maxScriptBytes, 8_192, 512_000, 512_000);
  const maxTotalBytes = clamp(request.maxTotalBytes, 64_000, 4_000_000, 2_000_000);
  const maxTraversalNodes = clamp(request.maxTraversalNodes, 500, 40_000, 20_000);
  const maxDepth = clamp(request.maxDepth, 8, 48, 40);
  const requestedShortcodes = new Set(
    (Array.isArray(request.candidateIds) ? request.candidateIds : [])
      .map(shortcodeFromCandidate)
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

  const documentScripts = [...(globalThis.document?.querySelectorAll?.(
    'script[type="application/json"]',
  ) ?? [])].slice(0, maxDocumentScripts);
  const scripts = [];
  for (const script of documentScripts) {
    if (scripts.length >= maxScripts) break;
    const text = typeof script?.textContent === "string" ? script.textContent : "";
    if (text.includes("image_versions2")) scripts.push(script);
  }

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

      const shortcode = shortcodeFromObject(value);
      const media = shortcode ? mediaFromObject(value) : [];
      if (media.length > 0) {
        matchedMediaObjectCount += 1;
        if (requestedShortcodes.size === 0 || requestedShortcodes.has(shortcode)) {
          mergeCandidate(shortcode, media);
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
    resolverVersion: "instagram-structured-carousel-v2",
    candidates: [...candidates.values()],
    diagnostics: Object.freeze({
      documentScriptCount: documentScripts.length,
      mediaScriptCount: scripts.length,
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

  function mergeCandidate(shortcode, media) {
    const candidateId = `instagram:post:${shortcode}`;
    const existing = candidates.get(candidateId)?.media ?? [];
    const merged = [];
    const mediaUrls = new Set();
    for (const entry of [...existing, ...media]) {
      const identity = entry?.playbackUrl || entry?.url;
      if (!identity || mediaUrls.has(identity)) continue;
      mediaUrls.add(identity);
      merged.push(entry);
      if (merged.length >= maxMediaPerCandidate) break;
    }
    if (merged.length > 0) candidates.set(candidateId, { candidateId, media: merged });
  }

  function mediaFromObject(value) {
    const carousel = dataProperty(value, "carousel_media");
    const result = [];
    for (const item of Array.isArray(carousel) ? carousel.slice(0, maxMediaPerCandidate) : []) {
      const media = mediaFromItem(item);
      if (media) result.push(media);
    }
    if (result.length > 0) return result;
    const direct = mediaFromItem(value);
    return direct ? [direct] : [];
  }

  function mediaFromItem(value) {
    const videoVersions = dataProperty(value, "video_versions");
    const playbackCandidates = [];
    for (const entry of Array.isArray(videoVersions) ? videoVersions.slice(0, 8) : []) {
      const playbackUrl = safeInstagramVideoUrl(dataProperty(entry, "url"));
      if (!playbackUrl) continue;
      playbackCandidates.push({
        url: playbackUrl,
        width: positiveInteger(dataProperty(entry, "width")),
        height: positiveInteger(dataProperty(entry, "height")),
      });
    }
    playbackCandidates.sort((left, right) => mediaScore(right) - mediaScore(left));
    const playback = playbackCandidates[0];
    const imageVersions = dataProperty(dataProperty(value, "image_versions2"), "candidates");
    const posterCandidates = [];
    for (const entry of Array.isArray(imageVersions) ? imageVersions.slice(0, 8) : []) {
      const posterUrl = safeInstagramImageUrl(dataProperty(entry, "url"));
      if (!posterUrl) continue;
      posterCandidates.push({
        url: posterUrl,
        width: positiveInteger(dataProperty(entry, "width")),
        height: positiveInteger(dataProperty(entry, "height")),
      });
    }
    posterCandidates.sort((left, right) => mediaScore(right) - mediaScore(left));
    const poster = posterCandidates[0];
    if (!poster) return null;
    return playback
      ? {
          kind: "video",
          url: poster.url,
          posterUrl: poster.url,
          playbackUrl: playback.url,
          playbackMode: "inline",
          width: playback.width || poster.width,
          height: playback.height || poster.height,
          provenance: "instagram_structured_json",
        }
      : {
          kind: "image",
          url: poster.url,
          width: poster.width,
          height: poster.height,
          provenance: "instagram_structured_json",
        };
  }

  function shortcodeFromObject(value) {
    return normalizeShortcode(dataProperty(value, "code")) ||
      normalizeShortcode(dataProperty(value, "shortcode"));
  }

  function shortcodeFromCandidate(value) {
    if (typeof value !== "string") return null;
    const direct = value.trim().match(/^instagram:(?:post|p|reel|tv):([A-Za-z0-9_-]+)$/i);
    if (direct) return direct[1];
    try {
      const url = new URL(value, "https://www.instagram.com/");
      if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) return null;
      return normalizeShortcode(url.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/i)?.[1]);
    } catch {
      return null;
    }
  }

  function normalizeShortcode(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9_-]{3,80}$/.test(text) ? text : null;
  }

  function safeInstagramVideoUrl(value) {
    const url = safeInstagramMediaUrl(value);
    if (!url || !/\.mp4$/i.test(new URL(url).pathname)) return null;
    return url;
  }

  function safeInstagramImageUrl(value) {
    const url = safeInstagramMediaUrl(value);
    if (!url || !/\.(?:avif|gif|heic|jpe?g|png|webp)$/i.test(new URL(url).pathname)) return null;
    return url;
  }

  function safeInstagramMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" || url.username || url.password || url.port ||
        !["fbcdn.net", "cdninstagram.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
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
