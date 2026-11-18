(() => {
  const supportedUrnPattern = /urn:li:(activity|share|ugcPost):(\d+)/i;
  const primaryCard = 'article, [role="article"], [role="listitem"], [data-view-name="feed-full-update"], .feed-shared-update-v2, [data-urn*="activity" i], [data-id*="activity" i]';
  const excluded = '[data-comment-id], [data-commentid], [role="comment"], .comments-comment-item, .comments-comments-list, [data-urn*="comment" i], [data-id*="comment" i], [data-testid*="comment" i], .update-components-mini-update-v2, [data-view-name="feed-shared-update-repost-content"]';
  const authoredBody = '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description';

  function ownsPrimaryNode(root, node, candidates = []) {
    if (!node || !root.contains(node) || node.closest(excluded)) return false;
    const card = node.closest(primaryCard);
    if (card && card !== root && root.contains(card)) return false;
    return !candidates.some(other => other !== root && root.contains(other) && other.contains(node));
  }

  function nativePostFromUrl(value) {
    const url = parseLinkedInUrl(value);
    if (!url || url.username || url.password || url.port) return null;
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return null; }
    const match = path.match(/^\/feed\/update\/urn:li:(activity|ugcPost|share):(\d{5,30})\/?$/i)
      ?? path.match(/^\/posts\/[^/]*[-_](activity|ugcPost|share)-(\d{5,30})(?:-[a-z0-9_-]+)?\/?$/i);
    return match ? nativePost(match[1], match[2]) : null;
  }

  function nativePost(kind, id) {
    const type = kind.toLowerCase();
    const urnKind = type === "ugcpost" ? "ugcPost" : type;
    return { id: `linkedin:${type}:${id}`, url: `https://www.linkedin.com/feed/update/urn:li:${urnKind}:${id}/` };
  }

  function primaryIdentityClaims(root, candidates = []) {
    const nodes = root.querySelectorAll("[data-urn], [data-id], a[href]");
    if (nodes.length > 100) throw new Error("probe_bound");
    const claims = new Map();
    const add = (post, source) => {
      if (post && !claims.has(post.id)) claims.set(post.id, { ...post, source });
      if (claims.size > 8) throw new Error("claim_bound");
    };
    for (const node of [root, ...nodes]) {
      if (!ownsPrimaryNode(root, node, candidates) || node.closest(authoredBody)) continue;
      for (const attribute of ["data-urn", "data-id"]) {
        const match = node.getAttribute(attribute)?.match(/^(?:urn:li:)?(activity|ugcPost|share)[:-](\d{5,30})$/i);
        if (match) add(nativePost(match[1], match[2]), "dom_urn");
      }
      if (node.matches("a[href]")) {
        add(nativePostFromUrl(node.href), node.querySelector("time") ? "time_anchor" : "direct_anchor");
      }
    }
    return [...claims.values()];
  }

  function resolvePostIdentity(root) {
    if (!root || root.isConnected === false) return { status: "unverified" };
    try {
      const claims = primaryIdentityClaims(root);
      if (!claims.length) return { status: "missing" };
      if (claims.length > 1) return { status: "conflicting" };
      return { status: "identified", ...claims[0] };
    } catch {
      return { status: "unverified" };
    }
  }

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
    nativePostFromUrl,
    ownsPrimaryNode,
    primaryCardSelector: primaryCard,
    primaryIdentityClaims,
    resolvePostIdentity,
  });
})();
