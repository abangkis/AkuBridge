// This function is intentionally self-contained so Chrome can serialize it into the MAIN world.
// It reads only bounded Video.js state and returns allowlisted LinkedIn post/video evidence.
export function resolveLinkedInStructuredMediaInMainWorld(request = {}) {
  const runtimeRevision = "linkedin-main-world-media-resolver-v1";
  const maxCandidates = clamp(request.maxCandidates, 1, 24, 16);
  const maxPlayers = clamp(request.maxPlayers, 1, 24, 16);
  const maxTraversalNodes = clamp(request.maxTraversalNodes, 200, 8_000, 3_000);
  const maxDepth = clamp(request.maxDepth, 3, 16, 10);
  const requestedIds = new Set(
    (Array.isArray(request.candidateIds) ? request.candidateIds : [])
      .map(normalizeCandidateId)
      .filter(Boolean)
      .slice(0, maxCandidates),
  );
  const requestedPlayerIds = new Set(
    (Array.isArray(request.playerIds) ? request.playerIds : [])
      .map((value) => typeof value === "string" ? value.trim().slice(0, 240) : "")
      .filter(Boolean)
      .slice(0, maxPlayers),
  );
  const documentObject = request.document ?? globalThis.document;
  const videojs = request.videojs ?? dataProperty(globalThis, "vjsForDebug");
  const roots = unique(unique([
    ...(documentObject?.querySelectorAll?.("[data-vjs-player]") ?? []),
    ...(documentObject?.querySelectorAll?.("video.vjs-tech") ?? []),
  ]).map((element) => element?.matches?.("[data-vjs-player]")
    ? element
    : element?.closest?.("[data-vjs-player]") ?? element?.parentElement)
    .filter(Boolean))
    .filter((root) => requestedPlayerIds.size === 0 || requestedPlayerIds.has(String(root?.id ?? "")))
    .slice(0, maxPlayers);

  const candidates = new Map();
  let traversedNodeCount = 0;
  let resolvedPlayerCount = 0;
  let directPlaybackURLCount = 0;
  let rejectedAdaptiveURLCount = 0;
  let candidateURNCount = 0;
  let assignedCandidateCount = 0;

  for (const root of roots) {
    if (traversedNodeCount >= maxTraversalNodes || candidates.size >= maxCandidates) break;
    const player = playerForRoot(root, videojs);
    if (player) resolvedPlayerCount += 1;
    const evidence = inspectPlayer(root, player);
    traversedNodeCount += evidence.traversedNodeCount;
    directPlaybackURLCount += evidence.playbackURLs.length;
    rejectedAdaptiveURLCount += evidence.rejectedAdaptiveURLCount;
    candidateURNCount += evidence.candidateIds.length;
    const candidateIds = evidence.candidateIds.length > 0
      ? evidence.candidateIds
      : requestedPlayerIds.has(String(root?.id ?? ""))
        ? [...requestedIds]
        : [];
    if (evidence.candidateIds.length === 0) assignedCandidateCount += candidateIds.length;
    const playbackUrl = preferredPlaybackURL(evidence.playbackURLs);
    const posterUrl = evidence.posterURLs[0] ?? posterFromDOM(root);
    if (!playbackUrl || !posterUrl) continue;

    const video = root.querySelector?.("video") ?? null;
    const rect = video?.getBoundingClientRect?.() ?? root.getBoundingClientRect?.() ?? {};
    const media = Object.freeze({
      kind: "video",
      url: posterUrl,
      posterUrl,
      playbackUrl,
      playbackMode: "inline",
      width: positiveInteger(video?.videoWidth) || positiveInteger(rect.width),
      height: positiveInteger(video?.videoHeight) || positiveInteger(rect.height),
      provenance: "linkedin_main_world_player",
    });
    for (const candidateId of candidateIds) {
      if (requestedIds.size > 0 && !requestedIds.has(candidateId)) continue;
      if (!candidates.has(candidateId)) candidates.set(candidateId, { candidateId, media: [media] });
      if (candidates.size >= maxCandidates) break;
    }
  }

  return Object.freeze({
    runtimeRevision,
    resolverVersion: "linkedin-main-world-video-v1",
    candidates: [...candidates.values()],
    diagnostics: Object.freeze({
      playerRootCount: roots.length,
      resolvedPlayerCount,
      directPlaybackURLCount,
      rejectedAdaptiveURLCount,
      candidateURNCount,
      assignedCandidateCount,
      candidateCount: candidates.size,
      traversedNodeCount,
      bounded: traversedNodeCount >= maxTraversalNodes || candidates.size >= maxCandidates,
    }),
  });

  function inspectPlayer(root, player) {
    const playbackURLs = [];
    const posterURLs = [];
    const candidateIds = new Set(candidateIdsFromContainer(root));
    let rejectedAdaptiveURLCount = 0;
    let visitedCount = 0;
    const seen = new Set();
    const queue = [];
    if (player) queue.push({ value: player, depth: 0 });
    for (const method of ["currentSource", "currentSources"]) {
      try {
        const value = typeof player?.[method] === "function" ? player[method]() : null;
        if (isObject(value)) queue.push({ value, depth: 0 });
      } catch {
        // Video.js diagnostics are optional and must never affect the player.
      }
    }

    while (queue.length > 0 && traversedNodeCount + visitedCount < maxTraversalNodes) {
      const current = queue.shift();
      const value = current?.value;
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      visitedCount += 1;
      for (const entry of dataEntries(value, 120)) {
        if (typeof entry.value === "string") {
          for (const candidateId of candidateIdsFromText(entry.value)) candidateIds.add(candidateId);
          const playback = safeLinkedInPlaybackURL(entry.value);
          if (playback) playbackURLs.push(playback);
          else if (looksAdaptiveVideoURL(entry.value)) rejectedAdaptiveURLCount += 1;
          const poster = safeLinkedInPosterURL(entry.value);
          if (poster) posterURLs.push(poster);
          continue;
        }
        if (current.depth < maxDepth && isObject(entry.value) && !seen.has(entry.value)) {
          queue.push({ value: entry.value, depth: current.depth + 1 });
        }
      }
    }
    return {
      playbackURLs: unique(playbackURLs),
      posterURLs: unique(posterURLs),
      candidateIds: [...candidateIds].slice(0, maxCandidates),
      rejectedAdaptiveURLCount,
      traversedNodeCount: visitedCount,
    };
  }

  function playerForRoot(root, api) {
    const id = String(root?.id ?? "");
    if (!id || !api) return null;
    try {
      const player = typeof api.getPlayer === "function" ? api.getPlayer(id) : null;
      if (player) return player;
    } catch {
      // Fall through to the public players registry.
    }
    try {
      const players = typeof api.getPlayers === "function" ? api.getPlayers() : dataProperty(api, "players");
      return dataProperty(players, id) ?? null;
    } catch {
      return null;
    }
  }

  function candidateIdsFromContainer(root) {
    const container = root?.closest?.(
      '[data-testid="mainFeed"] [role="listitem"], [data-view-name="feed-full-update"], '
      + '.feed-shared-update-v2, main [role="listitem"], main article',
    ) ?? root;
    const values = [container?.getAttribute?.("data-urn"), container?.getAttribute?.("data-id")];
    for (const element of container?.querySelectorAll?.("[data-urn], [data-id], a[href]") ?? []) {
      values.push(
        element.getAttribute?.("data-urn"),
        element.getAttribute?.("data-id"),
        element.href,
        element.getAttribute?.("href"),
      );
    }
    return unique(values.flatMap(candidateIdsFromText)).slice(0, maxCandidates);
  }

  function candidateIdsFromText(value) {
    const text = typeof value === "string" ? value : "";
    const ids = [];
    for (const match of text.matchAll(/urn:li:(activity|ugcPost|share):(\d{5,30})/gi)) {
      ids.push(`linkedin:${match[1].toLowerCase()}:${match[2]}`);
    }
    for (const match of text.matchAll(/activity[-/:](\d{5,30})/gi)) {
      ids.push(`linkedin:activity:${match[1]}`);
    }
    return unique(ids);
  }

  function normalizeCandidateId(value) {
    const text = typeof value === "string" ? value.trim() : "";
    const direct = text.match(/^linkedin:(activity|ugcpost|share):(\d{5,30})$/i);
    if (direct) return `linkedin:${direct[1].toLowerCase()}:${direct[2]}`;
    return candidateIdsFromText(text)[0] ?? null;
  }

  function posterFromDOM(root) {
    const scope = root?.parentElement?.parentElement ?? root;
    const values = [];
    for (const image of scope?.querySelectorAll?.("img[src]") ?? []) {
      values.push(image.currentSrc, image.src, image.getAttribute?.("src"));
    }
    for (const element of scope?.querySelectorAll?.("[style*='background-image']") ?? []) {
      values.push(element.style?.backgroundImage);
    }
    return values.flatMap(extractURLs).map(safeLinkedInPosterURL).find(Boolean) ?? null;
  }

  function extractURLs(value) {
    if (typeof value !== "string") return [];
    const urls = value.match(/https:\/\/[^"')\s]+/g);
    return urls ? urls.map((url) => url.replaceAll("&amp;", "&")) : [value];
  }

  function preferredPlaybackURL(values) {
    return unique(values).sort((left, right) => playbackScore(right) - playbackScore(left))[0] ?? null;
  }

  function playbackScore(value) {
    const resolution = Number(String(value).match(/\/mp4-(\d{2,4})p(?:-|\/)/i)?.[1]) || 0;
    return resolution;
  }

  function safeLinkedInPlaybackURL(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" || url.hostname.toLowerCase() !== "dms.licdn.com" ||
        url.username || url.password || url.port ||
        !/^\/playlist\//i.test(url.pathname) || !/\/mp4-\d{2,4}p(?:-|\/)/i.test(url.pathname)
      ) return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function looksAdaptiveVideoURL(value) {
    if (typeof value !== "string" || !/^https:\/\//i.test(value)) return false;
    return /(?:\.m3u8|\.mpd)(?:[?#]|$)|application\/(?:dash\+xml|vnd\.apple\.mpegurl)/i.test(value);
  }

  function safeLinkedInPosterURL(value) {
    if (typeof value !== "string") return null;
    for (const candidate of extractURLs(value)) {
      try {
        const url = new URL(candidate);
        const host = url.hostname.toLowerCase();
        const imagePoster = host === "media.licdn.com" && /^\/dms\/image\//i.test(url.pathname);
        const playlistPoster = host === "dms.licdn.com" &&
          /^\/playlist\/vid\//i.test(url.pathname) &&
          /\/thumbnail(?:-[a-z0-9]+)?\//i.test(url.pathname);
        if (
          url.protocol !== "https:" || url.username || url.password || url.port ||
          (!imagePoster && !playlistPoster)
        ) continue;
        url.hash = "";
        return url.href;
      } catch {
        // Continue through other bounded URL candidates.
      }
    }
    return null;
  }

  function dataEntries(value, limit) {
    const entries = [];
    for (const key of ownNames(value, limit)) {
      const child = dataProperty(value, key);
      if (child !== undefined) entries.push({ key, value: child });
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

  function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  }

  function isObject(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
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
