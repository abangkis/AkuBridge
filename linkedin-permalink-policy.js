(() => {
  const supportedUrnPattern = /urn:li:(activity|share|ugcPost):(\d+)/i;

  function canonicalFromEmbedHref(value) {
    const url = parseLinkedInUrl(value);
    if (!url) return null;
    return canonicalFromUrn(url.searchParams.get("targetUrn"));
  }

  function canonicalFromEvidence(value) {
    const url = parseLinkedInUrl(value);
    if (url) {
      const pathUrn = url.pathname.match(
        /\/feed\/update\/(urn:li:(?:activity|share|ugcPost):\d+)/i,
      )?.[1];
      const direct = canonicalFromUrn(pathUrn);
      if (direct) return direct;

      for (const key of ["targetUrn", "updateUrn", "activityUrn", "shareUrn", "ugcPostUrn"]) {
        const canonical = canonicalFromUrnEvidence(url.searchParams.get(key));
        if (canonical) return canonical;
      }
      return null;
    }
    if (/^https?:\/\//i.test(String(value ?? ""))) return null;
    return canonicalFromUrnEvidence(value);
  }

  function parseLinkedInUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, "https://www.linkedin.com/");
      return url.protocol === "https:" && url.hostname === "www.linkedin.com" ? url : null;
    } catch {
      return null;
    }
  }

  function canonicalFromUrnEvidence(value) {
    if (typeof value !== "string") return null;
    let candidate = value;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const canonical = canonicalFromUrn(candidate.match(supportedUrnPattern)?.[0]);
      if (canonical) return canonical;
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch {
        break;
      }
    }
    return null;
  }

  function canonicalFromUrn(value) {
    const match = String(value ?? "").match(supportedUrnPattern);
    if (!match || match[0].length !== String(value ?? "").length) return null;
    return `https://www.linkedin.com/feed/update/urn:li:${match[1]}:${match[2]}/`;
  }

  globalThis.AkuLinkedInPermalinkPolicy = Object.freeze({
    canonicalFromEmbedHref,
    canonicalFromEvidence,
  });
})();
