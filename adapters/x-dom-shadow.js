(() => {
  const engine = globalThis.AkuSharedDOMEngine;
  const primitives = globalThis.AkuCapturePrimitives;
  if (!engine || !primitives) return;

  const policy = Object.freeze({
    version: "x-shadow-v1",
    layouts: ["legacy", "wrapped"],
    postMarkers: [],
    requiredPrimaryFields: ["author"],
    modalities: [
      { field: "text", owner: "primary" },
      { field: "media", owner: "primary" },
      { field: "text", owner: "quote" },
      { field: "media", owner: "quote" },
    ],
  });
  const compactText = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const uniqueElements = elements => [...new Set(elements)];
  const helpers = { compactText, uniqueElements };
  const mediaEvidenceSelector = 'img[src]:not([src=""]), img[srcset]:not([srcset=""]), ' +
    'video[src]:not([src=""]), video[poster]:not([poster=""]), source[src]:not([src=""]), [style*="background-image: url"]';
  const maxCandidates = 64;
  const maxClaims = 8;

  function identityClaims(root, adapter, owner, excludeRoot, allowQuoteAnchors = owner === "quote") {
    return primitives.xPostIdentityClaims(root, {
      owner,
      isExcluded: node => excludeRoot?.contains(node),
      quoteContentRoot: () => adapter.resolveContentRoot(root),
      allowQuoteAnchors,
    });
  }

  function resolveIdentity(root, adapter, excludeRoot, allowQuoteAnchors) {
    const claims = identityClaims(root, adapter, "primary", excludeRoot, allowQuoteAnchors);
    const decision = engine.resolveDOMIdentity(claims);
    return {
      status: !decision.reason ? "identified" : decision.reason === "missing_identity" ? "missing" : "conflicting",
      permalink: decision.locator ?? null,
      candidates: [...new Set(claims.map(claim => claim.locator))],
      expectedPermalink: null,
      source: decision.provenance?.includes("post-wrapper") ? "post_wrapper"
        : decision.provenance?.includes("time-anchor") ? "time_anchor"
          : decision.locator ? "quote_anchor" : null,
    };
  }

  function candidateEvidence(root, index, visible, adapter) {
    const ref = String(index);
    const empty = { ref, visible, layout: null, identityClaims: [], fields: [] };
    if (!visible) return empty;
    try {
      const quote = adapter.findQuotedRoot(root);
      const primary = identityClaims(root, adapter, "primary", quote);
      const quoted = quote ? identityClaims(quote, adapter, "quote", adapter.findQuotedRoot(quote)) : [];
      if (primary.length + quoted.length > maxClaims) return { ...empty, probeFailed: true };
      const fields = [];
      const present = (name, owner, identityKey) =>
        fields.push({ name, owner, identityKey, availability: "present" });
      const hasMedia = (element, excludeRoot) => adapter.mediaAcquisition.extractCandidates(
        element, {
          uniqueElements, excludeRoot,
          collectRootCandidates: mediaRoot => {
            const hasSource = mediaRoot.matches(mediaEvidenceSelector) ||
              [...mediaRoot.querySelectorAll(mediaEvidenceSelector)].some(node => !excludeRoot?.contains(node));
            return hasSource ? [true] : [];
          },
        },
      ).length > 0;
      if (adapter.findAuthor(root, helpers)) present("author", "primary");
      if (adapter.extractText(root, helpers)) present("text", "primary");
      if (hasMedia(root, quote)) present("media", "primary");
      const quoteKeys = new Set(quoted.map(claim => claim.key));
      if (quoteKeys.size === 1) {
        const key = quoteKeys.values().next().value;
        if (adapter.extractText(quote, helpers)) present("text", "quote", key);
        if (hasMedia(quote)) present("media", "quote", key);
      }
      const layout = primary.some(claim => claim.provenance === "post-wrapper") ? "wrapped"
        : root.matches('article[data-testid="tweet"]') ? "legacy" : null;
      return { ref, visible, layout, identityClaims: [...primary, ...quoted], fields };
    } catch {
      return { ...empty, probeFailed: true };
    }
  }

  function assess({ adapter, candidates = [], visible, access = "available", loading = false, feedRoot = false }) {
    const current = {
      scope: "x-shadow",
      sampleSequence: 1,
      complete: candidates.length <= maxCandidates,
      settled: false,
      access,
      structure: {
        feedRoot, loading, empty: false, markers: [],
        visibleStructuralCount: 0, offscreenStructuralCount: 0,
      },
      candidates: [],
    };
    try {
      if (access === "available") {
        current.candidates = candidates.slice(0, maxCandidates).map((root, index) =>
          candidateEvidence(root, index, visible(root), adapter));
        const visibleCount = current.candidates.filter(candidate => candidate.visible).length;
        current.structure.visibleStructuralCount = visibleCount;
        current.structure.offscreenStructuralCount = current.candidates.length - visibleCount;
      }
      return engine.assessDOM({ schemaVersion: 1, policy, current }).diagnostic;
    } catch {
      return {
        code: "probe_failed",
        counts: { candidates: 0, visibleStructural: 0, accepted: 0, rejected: 0, offscreen: 0 },
        rejections: {},
      };
    }
  }

  globalThis.AkuXDOMShadow = Object.freeze({ assess, resolveIdentity });
})();
