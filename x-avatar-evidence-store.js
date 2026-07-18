const STORAGE_KEY = "akuXAvatarEvidenceStoreV1";
const RUNTIME_REVISION = "x-avatar-evidence-store-v1";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 512;

export function createXAvatarEvidenceStore(storageArea, options = {}) {
  if (!storageArea?.get || !storageArea?.set) {
    throw new TypeError("X avatar evidence storage requires get and set operations.");
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const ttlMs = clampInteger(options.ttlMs, 1_000, 30 * 24 * 60 * 60 * 1_000, DEFAULT_TTL_MS);
  const maxEntries = clampInteger(options.maxEntries, 1, 2_048, DEFAULT_MAX_ENTRIES);
  let statePromise;
  let mutation = Promise.resolve();

  function load() {
    if (!statePromise) {
      statePromise = Promise.resolve(storageArea.get(STORAGE_KEY)).then((value) => {
        const entries = new Map();
        for (const entry of Array.isArray(value?.[STORAGE_KEY]?.entries)
          ? value[STORAGE_KEY].entries
          : []) {
          const key = normalizeXAvatarEvidenceKey(entry?.key);
          const url = sanitizeXAvatarEvidenceUrl(entry?.url);
          if (!key || !url || Number(entry?.expiresAtMs) <= now()) continue;
          entries.set(key, { url, expiresAtMs: Number(entry.expiresAtMs) });
        }
        trim(entries, maxEntries);
        return entries;
      });
    }
    return statePromise;
  }

  function serialize(entries) {
    return {
      revision: RUNTIME_REVISION,
      updatedAtMs: now(),
      entries: [...entries].map(([key, entry]) => ({ key, ...entry })),
    };
  }

  function put(keys, value) {
    const normalizedKeys = uniqueKeys(keys).slice(0, 2);
    const url = sanitizeXAvatarEvidenceUrl(value);
    if (normalizedKeys.length === 0 || !url) {
      return Promise.resolve({ accepted: false, acceptedCount: 0 });
    }
    const operation = mutation.then(async () => {
      const entries = await load();
      purge(entries, now());
      for (const key of normalizedKeys) {
        entries.delete(key);
        entries.set(key, { url, expiresAtMs: now() + ttlMs });
      }
      trim(entries, maxEntries);
      await storageArea.set({ [STORAGE_KEY]: serialize(entries) });
      return { accepted: true, acceptedCount: normalizedKeys.length };
    });
    mutation = operation.catch(() => undefined);
    return operation;
  }

  async function lookup(keys) {
    await mutation;
    const entries = await load();
    const before = entries.size;
    purge(entries, now());
    const requested = uniqueKeys(keys).slice(0, 48);
    const matches = [];
    for (const key of requested) {
      const entry = entries.get(key);
      if (!entry) continue;
      entries.delete(key);
      entries.set(key, entry);
      matches.push({ key, url: entry.url });
    }
    if (entries.size !== before) {
      await storageArea.set({ [STORAGE_KEY]: serialize(entries) });
    }
    return {
      runtimeRevision: RUNTIME_REVISION,
      entries: matches,
      diagnostics: {
        requestedCount: requested.length,
        matchedCount: matches.length,
        retainedEntryCount: entries.size,
        ttlMs,
        maxEntries,
      },
    };
  }

  return Object.freeze({ runtimeRevision: RUNTIME_REVISION, put, lookup });
}

export function normalizeXAvatarEvidenceKey(value) {
  if (typeof value !== "string") return null;
  const status = value.match(/(?:^x:status:|\/status\/)(\d{5,30})(?:\b|\/|\?|#|$)/i);
  if (status) return `x:status:${status[1]}`;
  const user = value.trim().match(/^x:user:([A-Za-z0-9_]{1,15})$/i);
  return user ? `x:user:${user[1].toLowerCase()}` : null;
}

export function sanitizeXAvatarEvidenceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "pbs.twimg.com" ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/profile_images/")
    ) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function uniqueKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(normalizeXAvatarEvidenceKey)
    .filter(Boolean))];
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
