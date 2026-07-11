(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  const selectors = [
    '[data-testid="mainFeed"] [role="listitem"]',
    '[data-view-name="feed-full-update"]',
    ".feed-shared-update-v2",
    'main [role="listitem"]',
    'main [data-urn*="activity"]',
    'main [data-id*="activity"]',
    "main article",
  ];

  registry.register({
    source: "linkedin",
    version: "linkedin-dom-v2",
    matchesPage: () => window.location.hostname === "www.linkedin.com",
    loginRequired: () => (
      /\/login|\/uas\/login/i.test(window.location.pathname) ||
      Boolean(document.querySelector('input[name="session_key"], form[action*="login"]'))
    ),
    feedRootPresent: () => Boolean(
      document.querySelector('[data-testid="mainFeed"], #workspace main, main'),
    ),
    discoverCandidates: ({ compactText, uniqueElements }) => {
      const selectorCounts = Object.fromEntries(
        selectors.map((selector) => [selector, document.querySelectorAll(selector).length]),
      );
      const semantic = filterCandidates(uniqueElements(selectors.flatMap(
        (selector) => [...document.querySelectorAll(selector)],
      )));
      const actionAnchored = actionAnchoredCandidates(compactText, uniqueElements);
      return {
        candidates: uniqueElements([...semantic, ...actionAnchored]),
        semanticCandidateCount: semantic.length,
        actionAnchoredCandidateCount: actionAnchored.length,
        strategy: selectors.find((selector) => selectorCounts[selector] > 0) ??
          (actionAnchored.length > 0 ? "action_anchored" : "none"),
        selectorCounts,
      };
    },
    extractSemantics: (container, { compactText, normalizeHttpUrl }) => {
      const text = compactText(container.innerText);
      const relationshipType = /\breposted this\b/i.test(text)
        ? "repost"
        : /\breplied to\b/i.test(text)
          ? "reply"
          : "original";
      const parentPermalink = relationshipType === "original"
        ? null
        : [...container.querySelectorAll('a[href]')]
            .map((anchor) => normalizeHttpUrl(anchor.href))
            .find((href) => /\/feed\/update\/|activity-\d+/i.test(href ?? "")) ?? null;
      return {
        contentKind: container.querySelector("video")
          ? "video"
          : container.querySelector('[data-test-document-container], iframe[title*="document" i]')
            ? "document"
            : "post",
        relationshipType,
        parentPermalink,
        engagement: engagementCounts(container, compactText),
      };
    },
    findAuthor: (container, { compactText }) => {
      for (const selector of [
        ".update-components-actor__name",
        ".feed-shared-actor__name",
        '[data-view-name="feed-actor-image"]',
      ]) {
        const value = compactText(container.querySelector(selector)?.innerText).slice(0, 300);
        if (value) return value;
      }
      return "";
    },
    imageSelector: "img",
    shouldSkipImage: (image) => Boolean(image.closest(
      '.update-components-actor, .feed-shared-actor, [data-view-name="feed-actor-image"]',
    )),
    pendingContentPattern: /^(?:new posts?|show new posts?)$/i,
  });

  function filterCandidates(candidates) {
    return candidates.filter((element) => {
      if (element.matches(
        '[data-view-name="feed-full-update"], .feed-shared-update-v2, [data-urn*="activity"], [data-id*="activity"]',
      )) return true;
      if (element.querySelector(
        '[data-view-name="feed-full-update"], .feed-shared-update-v2, [data-urn*="activity"], [data-id*="activity"]',
      )) return true;
      return [...element.querySelectorAll('a[href]')].some((anchor) =>
        /\/feed\/update\/|activity-\d+/i.test(anchor.href),
      );
    });
  }

  function actionAnchoredCandidates(compactText, uniqueElements) {
    const main = document.querySelector("main");
    if (!main) return [];
    const actions = [...main.querySelectorAll('button,[role="button"]')]
      .filter((element) => actionKind(element, compactText));
    const candidates = [];
    for (const action of actions) {
      let current = action.parentElement;
      while (current && current !== main && current !== document.body) {
        const text = compactText(current.innerText);
        const actionKinds = new Set(
          [...current.querySelectorAll('button,[role="button"]')]
            .map((element) => actionKind(element, compactText))
            .filter(Boolean),
        );
        if (text.length >= 80 && actionKinds.size >= 2) {
          candidates.push(current);
          break;
        }
        current = current.parentElement;
      }
    }
    return uniqueElements(candidates).filter((candidate) =>
      !candidates.some((other) => other !== candidate && candidate.contains(other)),
    );
  }

  function actionKind(element, compactText) {
    const label = compactText(
      element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText,
    );
    return label.match(/^(like|comment|repost|send)(?:\b|$)/i)?.[1]?.toLowerCase() ?? null;
  }

  function engagementCounts(container, compactText) {
    const result = {};
    for (const element of container.querySelectorAll('button,[role="button"]')) {
      const label = compactText(element.getAttribute("aria-label") || element.innerText);
      const match = label.match(/([\d,.]+)\s+(reactions?|comments?|reposts?)/i);
      if (match) result[match[2].toLowerCase().replace(/s$/, "").replace("reaction", "like")] = match[1];
    }
    return result;
  }
})();
