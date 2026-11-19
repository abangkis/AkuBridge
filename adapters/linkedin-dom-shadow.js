(() => {
  const engine = globalThis.AkuSharedDOMEngine;
  const permalinkPolicy = globalThis.AkuLinkedInPermalinkPolicy;
  if (!engine || !permalinkPolicy) return;
  const version = "linkedin-shadow-v1";
  const maxCandidates = 64, maxNodes = 100;
  const policy = Object.freeze({
    version, layouts: ["native-card", "action-ancestor"], postMarkers: [],
    requiredPrimaryFields: ["author"],
    modalities: [{ field: "text", owner: "primary" }, { field: "media", owner: "primary" }],
  });
  const compactText = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const uniqueElements = values => [...new Set(values)];
  const failed = () => ({ code: "probe_failed",
    counts: { candidates: 0, visibleStructural: 0, accepted: 0, rejected: 0, offscreen: 0 }, rejections: {} });

  function primaryView(root, candidates) {
    const owned = node => permalinkPolicy.ownsPrimaryNode(root, node, candidates);
    const querySelectorAll = selector => {
      const nodes = root.querySelectorAll(selector);
      if (nodes.length > maxNodes) throw new Error("probe_bound");
      return [...nodes].filter(owned);
    };
    const text = node => {
      let visited = 0;
      const read = current => {
        if (++visited > maxNodes) throw new Error("probe_bound");
        if (current.nodeType === 3) return String(current.nodeValue ?? "").slice(0, 4_000);
        if (current.nodeType !== 1 || !owned(current)) return "";
        return [...current.childNodes].map(read).join(" ");
      };
      return node ? compactText(read(node)).slice(0, 4_000) : "";
    };
    return { owned, text, querySelectorAll, querySelector: selector => querySelectorAll(selector)[0] ?? null };
  }

  /**
   * @param {import("../shared-dom-engine/card-dom-adapter").CardCandidate} card
   * @returns {import("../shared-dom-engine/card-dom-adapter").CardEvidence}
   */
  function readCardEvidence({ root, ref, visible }, { adapter, candidates }) {
    const empty = { ref, visible, layout: null, identityClaims: [], fields: [] };
    if (!visible) return empty;
    try {
      if (root.isConnected === false) throw new Error("detached");
      const view = primaryView(root, candidates);
      const identityClaims = permalinkPolicy.primaryIdentityClaims(root, candidates).map(post => ({
        key: post.id, locator: post.url, owner: "primary", provenance: "native-post-evidence",
      }));
      const fields = [], present = name => fields.push({ name, owner: "primary", availability: "present" });
      const authorNode = node => node && ({ getAttribute: name => node.getAttribute(name), innerText: view.text(node) });
      const authorView = { querySelectorAll: selector => view.querySelectorAll(selector).map(authorNode),
        querySelector: selector => authorNode(view.querySelector(selector)) };
      if (adapter.findAuthor(authorView, { compactText })) present("author");
      // The declared authored-text root avoids treating header/control text as content.
      if (view.querySelector(adapter.contentRootSelector) && adapter.extractText(view, {
        compactText, structuredText: node => node === view ? "" : view.text(node),
      })) present("text");
      const media = adapter.mediaAcquisition.extractCandidates(view, { uniqueElements,
        collectRootCandidates(node) {
          const descendants = node.querySelectorAll("img, video, source");
          if (descendants.length > maxNodes) throw new Error("probe_bound");
          return [node, ...descendants].filter(view.owned).some(item =>
            [item.currentSrc, item.src, item.poster].some(value => {
              if (!value) return false;
              try {
                const url = new URL(value, window.location.href);
                return url.protocol === "https:" && !url.username && !url.password && !url.port &&
                  adapter.mediaHosts.some(host => url.hostname === host || url.hostname.endsWith("." + host));
              } catch { return false; }
            })) ? [true] : [];
        },
      });
      if (media.length) present("media");
      const layout = root.matches(permalinkPolicy.primaryCardSelector) ? "native-card" : "action-ancestor";
      return { ...empty, layout, identityClaims, fields };
    } catch { return { ...empty, probeFailed: true }; }
  }

  // One read-only sample cannot establish temporal drift, authentication or an empty feed.
  function assess({ adapter, candidates = [], visible, access = "available", loading = false, feedRoot = false }) {
    try {
      if (adapter?.source !== "linkedin" || window.location.hostname !== "www.linkedin.com") access = "wrong_route";
      if (access === "available" && adapter.loginRequired?.() === true) access = "login_required";
      if (access === "available" && (/\/checkpoint|\/challenge/i.test(window.location.pathname) ||
          document.querySelector('iframe[src*="captcha" i], [data-test-id*="challenge" i], #challenge-running, form[action*="checkpoint" i]') ||
          candidates.length === 0 && /^(?:verify you are human|unusual activity detected|security check required|robot check|captcha)$/im.test(String(document.body?.innerText ?? "").slice(0, 8000).trim()))) access = "challenge_required";
      const current = { scope: "linkedin-shadow", sampleSequence: 1, settled: false,
        complete: candidates.length <= maxCandidates, access,
        structure: { feedRoot, loading, empty: false, markers: [], visibleStructuralCount: 0, offscreenStructuralCount: 0 }, candidates: [] };
      if (access === "available") {
        const bounded = candidates.slice(0, maxCandidates);
        current.candidates = bounded.map((root, index) => readCardEvidence(
          { root, ref: String(index), visible: visible(root) }, { adapter, candidates: bounded },
        ));
        current.structure.visibleStructuralCount = current.candidates.filter(candidate => candidate.visible).length;
        current.structure.offscreenStructuralCount = current.candidates.length - current.structure.visibleStructuralCount;
      }
      return engine.assessDOM({ schemaVersion: engine.SCHEMA_VERSION, policy, current }).diagnostic;
    } catch { return failed(); }
  }
  globalThis.AkuLinkedInDOMShadow = Object.freeze({ version, assess });
})();
