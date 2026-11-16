(() => {
  const engine = globalThis.AkuSharedDOMEngine;
  if (!engine) return;
  const version = "instagram-shadow-v1";
  const maxCandidates = 64;
  const maxNodes = 100;
  const maxClaims = 8;
  const policy = Object.freeze({
    version, layouts: ["article", "permalink-ancestor"], postMarkers: [],
    requiredPrimaryFields: ["author"],
    modalities: [{ field: "text", owner: "primary" }, { field: "media", owner: "primary" }],
  });
  const compactText = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const uniqueElements = values => [...new Set(values)];
  const helpers = { compactText, uniqueElements };
  const commentSelector = '[data-comment-id], [data-commentid], [data-testid*="comment" i], [role="comment"]';
  const failed = () => ({ code: "probe_failed",
    counts: { candidates: 0, visibleStructural: 0, accepted: 0, rejected: 0, offscreen: 0 }, rejections: {} });

  function primaryView(root, candidates) {
    const owned = node => {
      if (!node || !root.contains(node) || node.closest(commentSelector)) return false;
      const article = node.closest('article, [role="article"]');
      if (article && article !== root && root.contains(article)) return false;
      return !candidates.some(other => other !== root && root.contains(other) && other.contains(node));
    };
    const querySelectorAll = selector => {
      const nodes = root.querySelectorAll(selector);
      if (nodes.length > maxNodes) throw new Error("probe_bound");
      return [...nodes].filter(owned);
    };
    return { owned, querySelectorAll, querySelector: selector => querySelectorAll(selector)[0] ?? null,
      tagName: root.tagName, matches: selector => root.matches(selector),
      closest: selector => root.closest(selector),
      getAttribute: name => root.getAttribute(name), contains: node => root.contains(node) };
  }

  function nativeClaim(anchor, adapter) {
    const url = new URL(anchor.href || anchor.getAttribute("href"), window.location.href);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["instagram.com", "www.instagram.com"].includes(url.hostname)) return null;
    const key = adapter.platformIdFromCandidates([url.href]);
    if (!key) return null;
    url.hostname = "www.instagram.com"; url.search = ""; url.hash = "";
    const identity = adapter.freshness.headless.primaryIdentity({ id: key, permalink: url.href });
    return identity ? { key: identity.id, locator: identity.permalink, owner: "primary", provenance: "native-post-anchor" } : null;
  }

  function candidateEvidence(root, index, visible, adapter, candidates) {
    const empty = { ref: String(index), visible, layout: null, identityClaims: [], fields: [] };
    if (!visible) return empty;
    try {
      if (root.isConnected === false) throw new Error("detached");
      const view = primaryView(root, candidates);
      const claims = new Map();
      for (const anchor of view.querySelectorAll("a[href]")) {
        let claim;
        try { claim = nativeClaim(anchor, adapter); } catch { continue; }
        if (claim) claims.set(claim.key, claim);
        if (claims.size > maxClaims) throw new Error("claim_bound");
      }
      const fields = [];
      const present = name => fields.push({ name, owner: "primary", availability: "present" });
      if (adapter.findAuthor(view, helpers)) present("author");
      if (adapter.extractText(view, helpers)) present("text");
      const media = adapter.mediaAcquisition.extractCandidates(view, { ...helpers,
        collectRootCandidates(node) {
          if (!view.owned(node)) return [];
          const values = node.tagName === "VIDEO"
            ? [node.poster, node.currentSrc, node.src] : [node.currentSrc, node.src];
          const observed = values.some(value => {
            if (!value) return false;
            try {
              const url = new URL(value, window.location.href);
              return url.protocol === "https:" && !url.username && !url.password && !url.port &&
                adapter.mediaHosts.some(host => url.hostname === host || url.hostname.endsWith("." + host));
            } catch { return false; }
          });
          return observed ? [true] : [];
        },
      });
      if (media.length) present("media");
      return { ...empty, layout: root.matches('article, [role="article"]') ? "article" : "permalink-ancestor",
        identityClaims: [...claims.values()], fields };
    } catch { return { ...empty, probeFailed: true }; }
  }

  // No temporal cache: one sample cannot establish DOM drift or an empty feed.
  // This never calls recovery, expansion, acquisition, navigation or storage.
  function assess({ adapter, candidates = [], visible, access = "available", loading = false, feedRoot = false }) {
    try {
      if (adapter?.source !== "instagram" || !["instagram.com", "www.instagram.com"].includes(window.location.hostname)) access = "wrong_route";
      if (access === "available" && (/\/checkpoint|\/challenge/i.test(window.location.pathname) ||
          document.querySelector('iframe[src*="captcha" i], [data-test-id*="challenge" i], #challenge-running, form[action*="checkpoint" i]') ||
          candidates.length === 0 && /^(?:verify you are human|unusual activity detected|security check required|robot check|captcha)$/im.test(String(document.body?.innerText ?? "").slice(0, 8000).trim()))) access = "challenge_required";
      const current = { scope: "instagram-shadow", sampleSequence: 1, settled: false,
        complete: candidates.length <= maxCandidates, access,
        structure: { feedRoot, loading, empty: false, markers: [], visibleStructuralCount: 0, offscreenStructuralCount: 0 }, candidates: [] };
      if (access === "available") {
        current.candidates = candidates.slice(0, maxCandidates).map((root, index) => candidateEvidence(root, index, visible(root), adapter, candidates));
        current.structure.visibleStructuralCount = current.candidates.filter(candidate => candidate.visible).length;
        current.structure.offscreenStructuralCount = current.candidates.length - current.structure.visibleStructuralCount;
      }
      return engine.assessDOM({ schemaVersion: engine.SCHEMA_VERSION, policy, current }).diagnostic;
    } catch { return failed(); }
  }
  globalThis.AkuInstagramDOMShadow = Object.freeze({ version, assess });
})();
