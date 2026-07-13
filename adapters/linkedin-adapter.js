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
    version: "linkedin-dom-v5",
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
      const menuLabel = [...container.querySelectorAll('button[aria-label]')]
        .map((button) => compactText(button.getAttribute("aria-label")))
        .find((label) => /^Open control menu for post by\s+/i.test(label));
      if (menuLabel) return menuLabel.replace(/^Open control menu for post by\s+/i, "").trim();
      for (const selector of [
        ".update-components-actor__name",
        ".feed-shared-actor__name",
        ".update-components-actor__title",
        ".feed-shared-actor__title",
        '[data-view-name="feed-actor-name"]',
        '[data-view-name="feed-actor-image"]',
      ]) {
        const value = compactText(container.querySelector(selector)?.innerText).slice(0, 300);
        if (value) return value;
      }
      return "";
    },
    extractText: (container, { compactText }) =>
      compactText(container.querySelector('[data-testid="expandable-text-box"]')?.innerText) ||
      compactText(container.innerText),
    extractPresentation: (container, { compactText, normalizeHttpUrl }) => {
      const author = postAuthor(container, compactText);
      const lines = String(container.innerText ?? "")
        .split(/\n+/)
        .map((line) => compactText(line))
        .filter(Boolean);
      const authorIndex = lines.findIndex((line) => line === author);
      const beforeAuthor = authorIndex >= 0 ? lines.slice(0, authorIndex) : [];
      const afterAuthor = authorIndex >= 0 ? lines.slice(authorIndex + 1) : [];
      const socialContext = beforeAuthor.find((line) =>
        /\b(?:likes?|reposted|commented on|celebrates?|supports?) this\b/i.test(line),
      ) ?? "";
      const connectionIndex = afterAuthor.findIndex((line) =>
        /^(?:•\s*)?(?:1st|2nd|3rd\+?)$/i.test(line),
      );
      const connectionDegree = connectionIndex >= 0
        ? afterAuthor[connectionIndex].replace(/^•\s*/, "")
        : "";
      const timestampText = afterAuthor.find((line) =>
        /^\d+\s*(?:m|h|d|w|mo|yr)s?\b/i.test(line),
      ) ?? "";
      const timestampIndex = timestampText ? afterAuthor.indexOf(timestampText) : -1;
      const headline = afterAuthor
        .slice(connectionIndex >= 0 ? connectionIndex + 1 : 0, timestampIndex >= 0 ? timestampIndex : undefined)
        .find((line) => !/^(?:Follow|Connect|\d+ followers?)$/i.test(line)) ?? "";
      const attributionText = afterAuthor.find((line) =>
        /\b(?:Promoted|Partnership with)\b/i.test(line) || /^with\s+.+?\s*[â€¢·]/i.test(line),
      ) ?? "";
      const socialAvatar = socialContext
        ? [...container.querySelectorAll('a[href*="/in/"] img')]
            .find((image) => {
              const rect = image.getBoundingClientRect();
              return rect.width > 0 && rect.width <= 36 && rect.height > 0 && rect.height <= 36;
            })
        : null;
      return {
        socialContext,
        socialContextAvatarUrl: normalizeHttpUrl(socialAvatar?.currentSrc || socialAvatar?.src),
        headline,
        attributionText,
        connectionDegree,
        timestampText,
        edited: /\bEdited\b/i.test(timestampText),
        promoted: lines.some((line) => /\bPromoted\b/i.test(line)),
      };
    },
    findAvatar: (container, { compactText, normalizeHttpUrl }) => {
      const author = postAuthor(container, compactText);
      const image = [...container.querySelectorAll('a[href] img')].find((candidate) => {
        const alt = compactText(candidate.alt);
        const rect = candidate.getBoundingClientRect();
        return rect.width >= 40 && rect.height >= 40 && (
          /^View company:/i.test(alt) ||
          (/^View .+profile/i.test(alt) && (!author || alt.includes(author.replace(/\s+[\p{Regional_Indicator}\s]+$/u, ""))))
        );
      }) ?? [...container.querySelectorAll('a[href] img')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width >= 32 && rect.width <= 80 && rect.height >= 32 && rect.height <= 80;
      });
      return normalizeHttpUrl(image?.currentSrc || image?.src);
    },
    imageSelector: "img",
    shouldSkipImage: (image) => Boolean(image.closest(
      '.update-components-actor, .feed-shared-actor, [data-view-name="feed-actor-image"]',
    )),
    pendingContentPattern: /^(?:new posts?|show new posts?)$/i,
  });

  function postAuthor(container, compactText) {
    const label = [...container.querySelectorAll('button[aria-label]')]
      .map((button) => compactText(button.getAttribute("aria-label")))
      .find((value) => /^Open control menu for post by\s+/i.test(value));
    return label?.replace(/^Open control menu for post by\s+/i, "").trim() ?? "";
  }

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
