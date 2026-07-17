const STORAGE_KEY = "akuXMediaEvidenceStoreV1";
const RUNTIME_REVISION = "x-media-evidence-store-v1";
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_MEDIA = 4;

export function createXMediaEvidenceStore(storageArea, options = {}) {
  if (!storageArea?.get || !storageArea?.set) {
    throw new TypeError("X media evidence storage requires get and set operations.");
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const ttlMs = clampInteger(options.ttlMs, 1_000, 24 * 60 * 60 * 1_000, DEFAULT_TTL_MS);
  const maxCandidates = clampInteger(options.maxCandidates, 1, 512, DEFAULT_MAX_CANDIDATES);
  const maxMedia = clampInteger(options.maxMedia, 1, 8, DEFAULT_MAX_MEDIA);
  let statePromise;
  let mutation = Promise.resolve();

  function load() {
    if (!statePromise) {
      statePromise = Promise.resolve(storageArea.get(STORAGE_KEY)).then((value) => {
        const raw = value?.[STORAGE_KEY];
        const entries = new Map();
        for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
          const candidateId = normalizeCandidateId(entry?.candidateId);
          if (!candidateId || Number(entry?.expiresAtMs) <= now()) continue;
          const media = sanitizeMedia(entry.media, maxMedia);
          if (media.length === 0) continue;
          entries.set(candidateId, {
            expiresAtMs: Number(entry.expiresAtMs),
            media,
          });
        }
        trim(entries, maxCandidates);
        return entries;
      });
    }
    return statePromise;
  }

  function serialize(entries) {
    return {
      revision: RUNTIME_REVISION,
      updatedAtMs: now(),
      entries: [...entries].map(([candidateId, entry]) => ({
        candidateId,
        expiresAtMs: entry.expiresAtMs,
        media: entry.media,
      })),
    };
  }

  function put(candidateId, values) {
    const normalizedID = normalizeCandidateId(candidateId);
    const media = sanitizeMedia(values, maxMedia);
    if (!normalizedID || media.length === 0) {
      return Promise.resolve({ accepted: false, candidateId: normalizedID });
    }
    const operation = mutation.then(async () => {
      const entries = await load();
      purge(entries, now());
      const previous = entries.get(normalizedID)?.media ?? [];
      const merged = sanitizeMedia([...media, ...previous], maxMedia);
      entries.delete(normalizedID);
      entries.set(normalizedID, { expiresAtMs: now() + ttlMs, media: merged });
      trim(entries, maxCandidates);
      await storageArea.set({ [STORAGE_KEY]: serialize(entries) });
      return { accepted: true, candidateId: normalizedID, mediaCount: merged.length };
    });
    mutation = operation.catch(() => undefined);
    return operation;
  }

  async function lookup(candidateIds) {
    await mutation;
    const entries = await load();
    const before = entries.size;
    purge(entries, now());
    if (entries.size !== before) {
      await storageArea.set({ [STORAGE_KEY]: serialize(entries) });
    }
    const requested = [...new Set((Array.isArray(candidateIds) ? candidateIds : [])
      .map(normalizeCandidateId)
      .filter(Boolean))].slice(0, 64);
    const candidates = [];
    for (const candidateId of requested) {
      const entry = entries.get(candidateId);
      if (!entry) continue;
      entries.delete(candidateId);
      entries.set(candidateId, entry);
      candidates.push({ candidateId, media: entry.media.map((value) => ({ ...value })) });
    }
    return {
      runtimeRevision: RUNTIME_REVISION,
      candidates,
      diagnostics: {
        requestedCount: requested.length,
        matchedCount: candidates.length,
        retainedCandidateCount: entries.size,
        ttlMs,
        maxCandidates,
        maxMediaPerCandidate: maxMedia,
      },
    };
  }

  return Object.freeze({ runtimeRevision: RUNTIME_REVISION, put, lookup });
}

export function normalizeXMediaCandidateId(value) {
  return normalizeCandidateId(value);
}

export function sanitizeXMediaEvidence(values, maximum = DEFAULT_MAX_MEDIA) {
  return sanitizeMedia(values, clampInteger(maximum, 1, 8, DEFAULT_MAX_MEDIA));
}

function normalizeCandidateId(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(?:^x:status:|\/status\/)(\d{5,30})(?:\b|\/|\?|#|$)/i);
  return match ? `x:status:${match[1]}` : null;
}

function sanitizeMedia(values, maximum) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== "object") continue;
    const posterUrl = safeXMediaURL(value.posterUrl || value.url);
    const playbackUrl = safeXMediaURL(value.playbackUrl);
    const primaryURL = posterUrl ?? playbackUrl;
    const identity = mediaIdentity(primaryURL, playbackUrl);
    if (!primaryURL || seen.has(identity)) continue;
    const kind = playbackUrl?.startsWith("https://video.twimg.com/") || value.kind === "video"
      ? "video"
      : "image";
    if (
      kind === "video" &&
      primaryURL.startsWith("https://video.twimg.com/") &&
      !posterUrl?.startsWith("https://pbs.twimg.com/")
    ) {
      continue;
    }
    seen.add(identity);
    output.push(Object.freeze({
      kind,
      url: primaryURL,
      posterUrl: kind === "video" && posterUrl?.startsWith("https://pbs.twimg.com/")
        ? posterUrl
        : null,
      playbackUrl: kind === "video" && playbackUrl?.startsWith("https://video.twimg.com/")
        ? playbackUrl
        : null,
      playbackMode: kind === "video" && playbackUrl ? "inline" : kind === "video" ? "native" : null,
      width: clampInteger(value.width, 0, 8_192, 0),
      height: clampInteger(value.height, 0, 8_192, 0),
      provenance: normalizeProvenance(value.provenance),
      observedAtMs: clampInteger(value.observedAtMs, 0, Number.MAX_SAFE_INTEGER, 0),
    }));
    if (output.length >= maximum) break;
  }
  return output;
}

function mediaIdentity(primaryURL, playbackURL) {
  return `${xAssetIdentity(primaryURL)}|${xAssetIdentity(playbackURL)}`;
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

function safeXMediaURL(value) {
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

function normalizeProvenance(value) {
  return value === "main_structured_state" ? value : "observed_dom";
}

function purge(entries, currentTime) {
  for (const [key, entry] of entries) {
    if (entry.expiresAtMs <= currentTime) entries.delete(key);
  }
}

function trim(entries, maximum) {
  while (entries.size > maximum) entries.delete(entries.keys().next().value);
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}
