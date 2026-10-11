// This function is intentionally self-contained so Chrome can serialize it into the MAIN world.
// It returns only candidate IDs and allowlisted media evidence; no React objects or response data
// cross the isolated-world boundary.
export function resolveXStructuredMediaInMainWorld(request = {}) {
  const runtimeRevision = "x-main-world-media-resolver-v1";
  const maxCandidates = clamp(request.maxCandidates, 1, 16, 12);
  const maxMediaPerCandidate = clamp(request.maxMediaPerCandidate, 1, 8, 4);
  const maxTraversalNodes = clamp(request.maxTraversalNodes, 100, 4_000, 1_500);
  // Headless React roots can place the owning Tweet at depth 13. Preserve the
  // existing Bridge default; deeper traversal requires an explicit bounded request.
  const maxDepth = clamp(request.maxDepth, 2, 16, 9);
  const requestedIds = new Set(
    (Array.isArray(request.candidateIds) ? request.candidateIds : [])
      .map(normalizeCandidateId)
      .filter(Boolean)
      .slice(0, maxCandidates),
  );
  const articles = unique([
    ...(globalThis.document?.querySelectorAll?.('article[data-testid="tweet"]') ?? []),
    ...(globalThis.document?.querySelectorAll?.("main article") ?? []),
  ]).slice(0, maxCandidates);
  const candidates = [];
  let traversedNodeCount = 0;
  let matchedStructuredNodeCount = 0;

  for (const article of articles) {
    const candidateId = candidateIdFromContainer(article);
    if (!candidateId || (requestedIds.size > 0 && !requestedIds.has(candidateId))) continue;
    const numericId = candidateId.slice("x:status:".length);
    const roots = reactRoots(article);
    const seen = new Set();
    const queue = roots.map((value) => ({ value, depth: 0 }));
    const matched = [];

    while (queue.length > 0 && traversedNodeCount < maxTraversalNodes) {
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      traversedNodeCount += 1;
      if (objectMatchesTweetId(value, numericId)) {
        matched.push(value);
        matchedStructuredNodeCount += 1;
      }
      if (current.depth >= maxDepth) continue;
      for (const child of dataValues(value, 80)) {
        if (isObject(child) && !seen.has(child)) {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }

    const media = request.playbackFormat === "mp4"
      ? collectMp4PreferredMedia(matched, numericId, maxMediaPerCandidate, maxDepth)
      : collectStructuredMedia(matched, numericId, maxMediaPerCandidate);
    if (request.playbackFormat !== "mp4") pairVideoEvidence(media);
    if (media.length > 0) candidates.push({ candidateId, media });
  }

  return Object.freeze({
    runtimeRevision,
    resolverVersion: "x-main-world-structured-v1",
    candidates,
    diagnostics: Object.freeze({
      articleCount: articles.length,
      candidateCount: candidates.length,
      traversedNodeCount,
      matchedStructuredNodeCount,
      bounded: traversedNodeCount >= maxTraversalNodes,
    }),
  });

  function reactRoots(element) {
    const roots = [];
    for (const key of ownNames(element, 80)) {
      if (!/^__(?:reactProps|reactFiber|reactContainer)\$/.test(key)) continue;
      const value = dataProperty(element, key);
      if (isObject(value)) roots.push(value);
    }
    return roots;
  }

  function candidateIdFromContainer(container) {
    const values = [];
    for (const time of container?.querySelectorAll?.("time") ?? []) {
      if (insideQuote(time, container)) continue;
      values.push(time.closest?.('a[href*="/status/"]')?.href);
    }
    for (const anchor of container?.querySelectorAll?.('a[href*="/status/"]') ?? []) {
      if (insideQuote(anchor, container)) continue;
      values.push(anchor.href, anchor.getAttribute?.("href"));
    }
    return values.map(normalizeCandidateId).find(Boolean) ?? null;
  }

  function insideQuote(element, container) {
    const quoted = element?.closest?.('[data-testid="quoteTweet"]');
    return Boolean(quoted && quoted !== container);
  }

  function normalizeCandidateId(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/(?:^x:status:|\/status\/)(\d{5,30})(?:\b|\/|\?|#|$)/i);
    return match ? `x:status:${match[1]}` : null;
  }

  function objectMatchesTweetId(value, numericId) {
    for (const key of ["rest_id", "id_str", "tweet_id", "tweetId"]) {
      const candidate = dataProperty(value, key);
      if (typeof candidate === "string" && candidate === numericId) return true;
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && String(candidate) === numericId) {
        return true;
      }
    }
    return false;
  }

  // X nests quoted and reposted Tweet result objects under the owning Tweet. Once the
  // media traversal crosses into a different explicit Tweet identity, that whole subtree
  // belongs to the nested post and must not be attributed to the outer candidate.
  function explicitTweetId(value) {
    for (const key of ["tweet_id", "tweetId"]) {
      const direct = numericIdentifier(dataProperty(value, key));
      if (direct) return direct;
    }
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

  function numericIdentifier(value) {
    if (typeof value === "string" && /^\d{5,30}$/.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      const normalized = String(value);
      return /^\d{5,30}$/.test(normalized) ? normalized : null;
    }
    return null;
  }

  function safeXMediaUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (host === "pbs.twimg.com") {
        if (!/^\/(?:media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|semantic_core_img)\//.test(url.pathname)) {
          return null;
        }
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
      return value;
    }
  }

  function dimensionsFromObject(value) {
    const directWidth = positiveInteger(dataProperty(value, "width") ?? dataProperty(value, "w"));
    const directHeight = positiveInteger(dataProperty(value, "height") ?? dataProperty(value, "h"));
    const original = dataProperty(value, "original_info");
    const originalWidth = positiveInteger(dataProperty(original, "width"));
    const originalHeight = positiveInteger(dataProperty(original, "height"));
    return {
      width: originalWidth || directWidth,
      height: originalHeight || directHeight,
    };
  }

  function collectStructuredMedia(matched, numericId, limit) {
    const media = [];
    const mediaSeen = new Set();
    let mediaNodesVisited = 0;
    const mediaQueue = matched.map((value) => ({ value, depth: 0 }));
    const mediaObjectsSeen = new Set();
    while (mediaQueue.length > 0 && mediaNodesVisited < 600 && media.length < limit) {
      const current = mediaQueue.shift();
      const value = current?.value;
      if (!isObject(value) || mediaObjectsSeen.has(value)) continue;
      mediaObjectsSeen.add(value);
      mediaNodesVisited += 1;
      const owningTweetId = explicitTweetId(value);
      if (owningTweetId && owningTweetId !== numericId) continue;
      const dimensions = dimensionsFromObject(value);
      for (const [key, rawUrl] of stringEntries(value, 80)) {
        if (!/(?:url|src|poster)/i.test(key)) continue;
        const url = safeXMediaUrl(rawUrl);
        const mediaIdentity = xAssetIdentity(url);
        if (!url || mediaSeen.has(mediaIdentity)) continue;
        const kind = url.startsWith("https://video.twimg.com/") ? "video" : "image";
        mediaSeen.add(mediaIdentity);
        media.push({
          kind,
          url,
          posterUrl: kind === "video" ? null : url,
          playbackUrl: kind === "video" ? url : null,
          playbackMode: kind === "video" ? "inline" : null,
          width: dimensions.width,
          height: dimensions.height,
          provenance: "main_structured_state",
        });
        if (media.length >= limit) break;
      }
      if (current.depth >= 7) continue;
      for (const child of dataValues(value, 80)) {
        if (isObject(child) && !mediaObjectsSeen.has(child)) {
          mediaQueue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
    return media;
  }

  // In MP4 mode, collect bounded poster and variant evidence before applying the output limit.
  function collectMp4PreferredMedia(matched, numericId, limit, maxMediaDepth) {
    const posters = new Map();
    const variants = new Map();
    const images = [];
    const imageSeen = new Set();
    const directVideoEntities = new Map();
    let mediaNodesVisited = 0;
    const mediaQueue = matched.map((value) => ({ value, depth: 0 }));
    const mediaObjectsSeen = new Set();
    while (mediaQueue.length > 0 && mediaNodesVisited < 600) {
      const current = mediaQueue.shift();
      const value = current?.value;
      if (!isObject(value) || mediaObjectsSeen.has(value)) continue;
      mediaObjectsSeen.add(value);
      mediaNodesVisited += 1;
      const owningTweetId = explicitTweetId(value);
      if (owningTweetId && owningTweetId !== numericId) continue;
      const dimensions = dimensionsFromObject(value);
      const directVideo = directPairFromVideoEntity(value);
      if (directVideo) {
        const posterIdentity = xAssetIdentity(directVideo.posterUrl);
        const previous = directVideoEntities.get(posterIdentity);
        if (directVideo.ambiguous) {
          directVideoEntities.set(posterIdentity, { conflict: true });
        } else if (previous?.conflict) {
          // Once the same poster is tied to conflicting entity evidence, fail closed.
        } else if (previous && previous.assetIdentity !== directVideo.assetIdentity) {
          directVideoEntities.set(posterIdentity, { conflict: true });
        } else if (!previous || playbackArea(directVideo.playbackUrl) > playbackArea(previous.item.playbackUrl)) {
          directVideoEntities.set(posterIdentity, {
            assetIdentity: directVideo.assetIdentity,
            item: {
              kind: "video",
              url: directVideo.posterUrl,
              posterUrl: directVideo.posterUrl,
              playbackUrl: directVideo.playbackUrl,
              playbackMode: "inline",
              pairing: "same_video_media_entity",
              width: dimensions.width,
              height: dimensions.height,
              provenance: "main_structured_state",
            },
          });
        }
      }
      for (const [key, rawUrl] of stringEntries(value, 80)) {
        if (!/(?:url|src|poster)/i.test(key)) continue;
        const url = safeXMediaUrl(rawUrl);
        if (!url) continue;
        const parsed = new URL(url);
        if (parsed.hostname === "pbs.twimg.com") {
          const identity = videoAssetIdentity(url);
          if (identity) {
            if (!posters.has(identity)) {
              posters.set(identity, {
                url,
                width: dimensions.width,
                height: dimensions.height,
              });
            }
            continue;
          }
          const mediaIdentity = xAssetIdentity(url);
          if (images.length >= limit || imageSeen.has(mediaIdentity)) continue;
          imageSeen.add(mediaIdentity);
          images.push({
            kind: "image",
            url,
            posterUrl: url,
            playbackUrl: null,
            playbackMode: null,
            width: dimensions.width,
            height: dimensions.height,
            provenance: "main_structured_state",
          });
          continue;
        }
        if (parsed.hostname !== "video.twimg.com" || !/\.mp4$/i.test(parsed.pathname)) continue;
        const identity = videoAssetIdentity(url);
        if (!identity) continue;
        const previous = variants.get(identity);
        if (!previous || playbackArea(url) > playbackArea(previous)) variants.set(identity, url);
      }
      if (current.depth >= maxMediaDepth) continue;
      for (const child of dataValues(value, 80)) {
        if (isObject(child) && !mediaObjectsSeen.has(child)) {
          mediaQueue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }

    const pairedPosters = [];
    const unresolvedPosters = [];
    for (const [identity, poster] of posters) {
      const playbackUrl = variants.get(identity) ?? null;
      const item = {
        kind: playbackUrl ? "video" : "image",
        url: poster.url,
        posterUrl: poster.url,
        playbackUrl,
        playbackMode: playbackUrl ? "inline" : null,
        width: poster.width,
        height: poster.height,
        provenance: "main_structured_state",
      };
      (playbackUrl ? pairedPosters : unresolvedPosters).push(item);
    }
    const directPairs = [];
    const directPosterIdentities = new Set();
    for (const [posterIdentity, value] of directVideoEntities) {
      if (value.conflict || !value.item) continue;
      directPairs.push(value.item);
      directPosterIdentities.add(posterIdentity);
    }
    const remainingImages = images.filter((item) => !directPosterIdentities.has(xAssetIdentity(item.url)));
    return [...directPairs, ...pairedPosters, ...unresolvedPosters, ...remainingImages].slice(0, limit);
  }

  // Pair only evidence carried by one explicit video media entity. Generic /media posters do
  // not expose the video asset ID, so variants from neighboring entities cannot identify them.
  function directPairFromVideoEntity(value) {
    const type = dataProperty(value, "type");
    if (type !== "video" && type !== "animated_gif") return null;
    const videoInfo = dataProperty(value, "video_info");
    const variants = dataProperty(videoInfo, "variants");
    if (!Array.isArray(variants)) return null;
    const variantLength = dataProperty(variants, "length");
    if (!Number.isSafeInteger(variantLength) || variantLength < 0) return null;

    const posterCandidates = [];
    for (const key of ["media_url_https", "media_url", "poster_url", "posterUrl", "poster", "url"]) {
      const posterUrl = safeGenericVideoPosterUrl(dataProperty(value, key));
      if (posterUrl) posterCandidates.push(posterUrl);
    }
    const postersByIdentity = new Map();
    for (const posterUrl of posterCandidates) {
      const identity = xAssetIdentity(posterUrl);
      if (!postersByIdentity.has(identity)) postersByIdentity.set(identity, posterUrl);
    }
    if (postersByIdentity.size !== 1) return null;
    const posterUrl = [...postersByIdentity.values()][0];
    // Unexamined variants could bind this poster to another asset. A capped
    // traversal cannot establish an unambiguous entity in that case.
    if (variantLength > 32) return { posterUrl, ambiguous: true };

    const assets = new Map();
    const variantCount = Math.min(variantLength, 32);
    for (let index = 0; index < variantCount; index += 1) {
      const variant = dataProperty(variants, String(index));
      if (!isObject(variant)) continue;
      const contentType = dataProperty(variant, "content_type");
      if (contentType !== undefined &&
          (typeof contentType !== "string" || contentType.trim().toLowerCase() !== "video/mp4")) continue;
      const playbackUrl = safeProgressiveVideoUrl(dataProperty(variant, "url"));
      if (!playbackUrl) continue;
      const assetIdentity = videoAssetIdentity(playbackUrl);
      if (!assetIdentity) continue;
      const previous = assets.get(assetIdentity);
      if (!previous || playbackArea(playbackUrl) > playbackArea(previous)) assets.set(assetIdentity, playbackUrl);
    }
    if (assets.size === 0) return null;
    if (assets.size > 1) return { posterUrl, ambiguous: true };
    const [assetIdentity, playbackUrl] = [...assets.entries()][0];
    return { posterUrl, assetIdentity, playbackUrl, ambiguous: false };
  }

  function safeGenericVideoPosterUrl(value) {
    const url = safeStrictXUrl(value, "pbs.twimg.com");
    if (!url || !/^\/media\//i.test(url.pathname)) return null;
    const extension = url.pathname.match(/\.(jpe?g|png|gif|webp|avif)$/i)?.[1]?.toLowerCase() ?? null;
    const formats = url.searchParams.getAll("format").map((format) => format.toLowerCase());
    const supportedFormats = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
    if (formats.some((format) => !supportedFormats.has(format))) return null;
    if (!extension && (formats.length !== 1 || !supportedFormats.has(formats[0]))) return null;
    return url.href;
  }

  function safeProgressiveVideoUrl(value) {
    const url = safeStrictXUrl(value, "video.twimg.com");
    if (!url || !/^\/(?:amplify_video|ext_tw_video|tweet_video)\/[^/]+\//i.test(url.pathname)) return null;
    return /\.mp4$/i.test(url.pathname) ? url.href : null;
  }

  function safeStrictXUrl(value, expectedHost) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          url.hostname.toLowerCase() !== expectedHost) return null;
      url.hash = "";
      return url;
    } catch {
      return null;
    }
  }

  function pairVideoEvidence(media) {
    const playback = media.find((value) => value.playbackUrl);
    const poster = media.find((value) => value.url?.startsWith("https://pbs.twimg.com/") &&
      /video_thumb|tweet_video_thumb/.test(new URL(value.url).pathname));
    if (!playback || !poster) return;
    poster.kind = "video";
    poster.posterUrl = poster.url;
    poster.playbackUrl = playback.playbackUrl;
    poster.playbackMode = "inline";
    const playbackIndex = media.indexOf(playback);
    if (playbackIndex >= 0 && playback !== poster) media.splice(playbackIndex, 1);
  }

  function videoAssetIdentity(value) {
    try {
      const path = new URL(value).pathname;
      const match = path.match(/^\/(ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/([^/]+)/);
      return match ? `${match[1]}:${match[2].replace(/\.(?:jpg|jpeg|png|webp|avif|gif|mp4)$/i, "")}` : null;
    } catch { return null; }
  }

  function playbackArea(value) {
    const size = new URL(value).pathname.match(/\/(\d{1,4})x(\d{1,4})\//);
    return size && Number(size[1]) <= 8192 && Number(size[2]) <= 8192 ? Number(size[1]) * Number(size[2]) : 0;
  }

  function dataValues(value, limit) {
    const values = [];
    for (const key of ownNames(value, limit)) {
      const child = dataProperty(value, key);
      if (child !== undefined) values.push(child);
    }
    return values;
  }

  function stringEntries(value, limit) {
    const entries = [];
    for (const key of ownNames(value, limit)) {
      const child = dataProperty(value, key);
      if (typeof child === "string") entries.push([key, child]);
    }
    return entries;
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
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(8_192, Math.round(number)) : 0;
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }
}
