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
  const actorAvatarSelector = [
    'a[href*="/in/"] img',
    'a[href*="/company/"] img',
    'a[href*="/school/"] img',
    'a[href*="/showcase/"] img',
  ].join(", ");

  registry.register({
    source: "linkedin",
    version: "linkedin-dom-v15",
    maxBlocksPerSnapshot: 8,
    scrollContext: "nearest_scrollable",
    scrollRootSelectors: Object.freeze(['[data-testid="mainFeed"]', "main", "#workspace"]),
    contentExpansion: Object.freeze({
      buttonSelector: '[data-testid="expandable-text-button"]',
      restorable: true,
      attempts: 10,
      intervalMs: 40,
    }),
    avatarFallbackSelectors: Object.freeze([
      ".update-components-actor__avatar-image",
      ".feed-shared-actor__avatar-image",
      '[data-view-name="feed-actor-image"] img',
      ".update-components-actor img",
      ".feed-shared-actor img",
    ]),
    permalinkPatterns: Object.freeze([/\/feed\/update\//, /activity-\d+/]),
    findDomPermalink: (container) => [
      container.getAttribute("data-urn"),
      container.getAttribute("data-id"),
      ...[...container.querySelectorAll("[data-urn], [data-id]")]
        .slice(0, 20)
        .flatMap((element) => [element.getAttribute("data-urn"), element.getAttribute("data-id")]),
    ].filter(Boolean).map((value) => {
      const canonical = globalThis.AkuLinkedInPermalinkPolicy?.canonicalFromEvidence(String(value));
      if (canonical) return canonical;
      const activityId = String(value).match(/activity(?::|-)(\d+)/i)?.[1];
      return activityId ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/` : null;
    }).find(Boolean) ?? null,
    estimateRelativeTimestamp: (timestampText, capturedAt) =>
      globalThis.AkuLinkedInTimestampPolicy?.estimateFromRelativeText(timestampText, capturedAt) ?? null,
    recoverPermalinks: recoverLinkedInPermalinks,
    mediaHosts: Object.freeze(["licdn.com"]),
    platformIdFromCandidates: (values) => {
      for (const value of Array.isArray(values) ? values : []) {
        const candidate = String(value ?? "");
        const urn = candidate.match(/urn:li:(activity|ugcPost|share):(\d+)/i);
        if (urn) return `linkedin:${urn[1].toLowerCase()}:${urn[2]}`;
        const activity = candidate.match(/activity[-/:](\d+)/i);
        if (activity) return `linkedin:activity:${activity[1]}`;
      }
      return null;
    },
    qualityProfile: "social-post-v1",
    qualitySelectors: Object.freeze({
      author: 'button[aria-label^="Open control menu for post by"], '
        + '.update-components-actor__name, .feed-shared-actor__name, '
        + '[data-view-name="feed-actor-name"]',
      avatar: '.update-components-actor__avatar-image, '
        + '.feed-shared-actor__avatar-image, '
        + '[data-view-name="feed-actor-image"] img, '
        + '.update-components-actor img, .feed-shared-actor img, '
        + actorAvatarSelector,
      content: '[data-testid="expandable-text-box"]',
      media: '.update-components-image, .feed-shared-image, '
        + 'video, [data-test-document-container], '
        + 'iframe[title*="document" i]',
      timestamp: "time",
    }),
    freshness: Object.freeze({
      version: "linkedin-freshness-v2",
      wakeWhenBackground: true,
      settledWakeIsCurrent: true,
      wakeObservationMs: 4_000,
      probeIntervalMs: 250,
      revealSupported: true,
      revealObservationMs: 12_000,
      rejectInsideFeedCandidate: true,
      pendingContentPattern: /^(?:new posts?|show new posts?)$/i,
    }),
    mediaAcquisition: Object.freeze({
      version: "linkedin-media-acquisition-v1",
      maxAttempts: 1,
      settleMs: 900,
      quietRecovery: "bounded_dom",
      detectExpectedKinds: detectLinkedInExpectedMediaKinds,
      extractCandidates: extractLinkedInRecoveryCandidates,
    }),
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
    contentRootSelector: '[data-testid="expandable-text-box"]',
    extractText: (container, { compactText, structuredText }) => {
      const read = typeof structuredText === "function" ? structuredText : compactText;
      return stripExpansionControl(
        read(container.querySelector('[data-testid="expandable-text-box"]')),
      ) || read(container);
    },
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
        /\b(?:likes?|reposted|commented(?:\s+on)?|celebrates?|supports?)(?:\s+this)?$/i.test(line),
      ) ?? "";
      const connectionIndex = afterAuthor.findIndex((line) =>
        /^(?:[\u2022\u00b7]\s*)?(?:1st|2nd|3rd\+?)$/i.test(line),
      );
      const connectionDegree = connectionIndex >= 0
        ? afterAuthor[connectionIndex].replace(/^[\u2022\u00b7]\s*/, "")
        : "";
      const timestampLine = afterAuthor.find((line) =>
        /^\d+\s*(?:m|h|d|w|mo|yr)s?\b/i.test(line),
      ) ?? "";
      const timestampText = timestampLine.replace(/\s*[\u2022\u00b7]\s*$/, "");
      const timestampIndex = timestampLine ? afterAuthor.indexOf(timestampLine) : -1;
      const headline = afterAuthor
        .slice(connectionIndex >= 0 ? connectionIndex + 1 : 0, timestampIndex >= 0 ? timestampIndex : undefined)
        .find((line) => !/^(?:Follow|Connect|\d+ followers?)$/i.test(line)) ?? "";
      const attributionText = afterAuthor.find((line) =>
        /\b(?:Promoted|Partnership with)\b/i.test(line) || /^with\s+.+?\s*[\u2022\u00b7]/i.test(line),
      ) ?? "";
      const promoted = lines.some((line) => /\bPromoted\b/i.test(line));
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
        timestampAvailability: timestampLine
          ? "relative_text"
          : promoted
            ? "not_exposed_promoted"
            : "unavailable",
        edited: /\bEdited\b/i.test(timestampText),
        promoted,
      };
    },
    extractAttachments: (container, { compactText, normalizeHttpUrl, normalizeHttpsUrl }) =>
      extractLinkedInAttachments(container, { compactText, normalizeHttpUrl, normalizeHttpsUrl }),
    findAvatar: (container, { compactText, normalizeHttpUrl }) => {
      const author = postAuthor(container, compactText);
      const candidates = [...container.querySelectorAll(actorAvatarSelector)];
      const image = candidates.find((candidate) => {
        const alt = compactText(candidate.alt);
        const rect = candidate.getBoundingClientRect();
        return rect.width >= 40 && rect.height >= 40 && (
          /^View .+profile/i.test(alt) &&
          (!author || alt.includes(author.replace(/\s+[\p{Regional_Indicator}\s]+$/u, "")))
        );
      }) ?? candidates.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width >= 40 && rect.width <= 80 && rect.height >= 40 && rect.height <= 80;
      });
      return normalizeHttpUrl(image?.currentSrc || image?.src);
    },
    imageSelector: "img",
    shouldSkipImage: (image) => Boolean(image.closest(
      '.update-components-actor, .feed-shared-actor, [data-view-name="feed-actor-image"]',
    )),
  });

  function postAuthor(container, compactText) {
    const label = [...container.querySelectorAll('button[aria-label]')]
      .map((button) => compactText(button.getAttribute("aria-label")))
      .find((value) => /^Open control menu for post by\s+/i.test(value));
    return label?.replace(/^Open control menu for post by\s+/i, "").trim() ?? "";
  }

  async function recoverLinkedInPermalinks(containers, operationDeadlineAtMs, helpers) {
    const recovered = new WeakMap();
    const deadlineAtMs = Math.min(Date.now() + 2_000, operationDeadlineAtMs);
    for (const container of containers) {
      if (helpers.findPermalinkDetails(container, "linkedin", container.querySelector("time"))) continue;
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        recovered.set(container, {
          url: null,
          source: "unavailable",
          reason: "LinkedIn permalink recovery budget was exhausted for this snapshot.",
        });
        continue;
      }
      const menuButton = container.querySelector('button[aria-label^="Open control menu for post by"]');
      if (!menuButton) {
        recovered.set(container, { url: null, source: "unavailable", reason: "Post control menu was not exposed." });
        continue;
      }
      const visibleEvidence = () => [...document.querySelectorAll(
        '[role="menu"] a[href], [role="menu"] [role="menuitem"][href]',
      )]
        .filter((link) => helpers.isVisibleInViewport(link))
        .map((link) => ({
          href: link.href,
          url: globalThis.AkuLinkedInPermalinkPolicy?.canonicalFromEvidence(link.href) ?? null,
          source: /\/preload\/embed-modal\//i.test(link.pathname) ? "embed_urn" : "menu_urn",
        }))
        .filter((entry) => entry.url);
      const previouslyVisible = new Set(visibleEvidence().map((entry) => entry.href));
      let opened = false;
      try {
        menuButton.click();
        opened = true;
        const evidence = await helpers.waitForValue(
          () => visibleEvidence().find((entry) => !previouslyVisible.has(entry.href))
            ?? visibleEvidence()[0]
            ?? null,
          Math.max(1, Math.ceil(remainingMs / 50)),
          50,
        );
        recovered.set(container, evidence?.url
          ? { url: evidence.url, source: evidence.source, reason: "" }
          : { url: null, source: "unavailable", reason: "No stable post URN was exposed after opening the post menu." });
      } finally {
        if (opened) {
          menuButton.click();
          await helpers.waitForValue(() => visibleEvidence().length === 0 ? true : null, 4, 25);
        }
      }
    }
    return recovered;
  }

  function extractLinkedInRecoveryCandidates(container, {
    excludeRoot,
    collectRootCandidates,
    uniqueElements,
  }) {
    return linkedInMediaRoots(container, { excludeRoot, uniqueElements }).flatMap(({ root, kind }) =>
      collectRootCandidates(root, {
        kind: kind === "document" ? "image" : kind,
        alt: root.getAttribute?.("aria-label") || root.getAttribute?.("title") || "",
      }));
  }

  function detectLinkedInExpectedMediaKinds(container, { excludeRoot, uniqueElements }) {
    return linkedInMediaRoots(container, { excludeRoot, uniqueElements }).map(({ kind }) => kind);
  }

  function linkedInMediaRoots(container, { excludeRoot, uniqueElements }) {
    const imageSelector = ".update-components-image, .feed-shared-image";
    const videoSelector = "video, [data-view-name*='video' i], [aria-label*='video' i]";
    const documentSelector = "[data-test-document-container], iframe[title*='document' i]";
    const values = [
      ...uniqueElements([...container.querySelectorAll(imageSelector)])
        .map((root) => ({ root, kind: "image" })),
      ...uniqueElements([...container.querySelectorAll(videoSelector)])
        .map((root) => ({ root, kind: "video" })),
      ...uniqueElements([...container.querySelectorAll(documentSelector)])
        .map((root) => ({ root, kind: "document" })),
    ];
    return values.filter(({ root }, index, all) =>
      !excludeRoot?.contains?.(root) && all.findIndex((entry) => entry.root === root) === index,
    );
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
      const visibleCount = compactText(element.innerText).match(/[\d,.]+(?:[KMB])?/i)?.[0] ?? "";
      if (/^Reaction button state:/i.test(label) && visibleCount) {
        result.like = visibleCount;
        continue;
      }
      if (/^Comment\b/i.test(label) && visibleCount) {
        result.comment = visibleCount;
        continue;
      }
      if (/^Repost\b/i.test(label) && visibleCount) {
        result.repost = visibleCount;
        continue;
      }
      const match = label.match(/([\d,.]+)\s+(reactions?|comments?|reposts?)/i);
      if (match) result[match[2].toLowerCase().replace(/s$/, "").replace("reaction", "like")] = match[1];
    }
    return result;
  }

  function extractLinkedInAttachments(container, helpers) {
    const attachments = [];
    for (const link of container.querySelectorAll('a[href]')) {
      const directUrl = helpers.normalizeHttpsUrl(link.href);
      if (!directUrl) continue;
      const attachment = /\/jobs\/view\//i.test(directUrl)
        ? extractLinkedInJob(link, directUrl, helpers)
        : extractLinkedInExternalCard(link, directUrl, container, helpers);
      if (!attachment || attachments.some((value) => value.url === attachment.url)) continue;
      attachments.push(attachment);
      if (attachments.length >= 3) break;
    }
    return attachments;
  }

  function extractLinkedInJob(link, url, { compactText, normalizeHttpsUrl }) {
    const lines = String(link.innerText ?? "")
      .split(/\n+/)
      .map((line) => compactText(line))
      .filter(Boolean);
    const verified = lines.some((line) => /\bVerified job\b/i.test(line));
    const actionLabel = lines.find((line) => /^View job$/i.test(line)) ?? "View job";
    const footnote = lines.find((line) => /\balumni\b|\bwork here\b/i.test(line)) ?? "";
    const details = lines
      .filter((line) => line !== actionLabel && line !== footnote)
      .map((line) => line.replace(/\s*\(Verified job\)\s*$/i, "").trim())
      .filter(Boolean);
    const title = details[0] ?? "LinkedIn job";
    const distinctDetails = details.slice(1).filter((line) => line !== title);
    const images = [...link.querySelectorAll("img")].sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
    return {
      kind: "job",
      title: compactText(title).slice(0, 300),
      subtitle: compactText(distinctDetails[0] ?? "").slice(0, 300),
      detail: compactText(distinctDetails[1] ?? "").slice(0, 300),
      actionLabel: compactText(actionLabel).slice(0, 80),
      footnote: compactText(footnote).slice(0, 300),
      url,
      imageUrl: linkedInThumbnailUrl(images[0]?.currentSrc || images[0]?.src, normalizeHttpsUrl),
      verified,
    };
  }

  function extractLinkedInExternalCard(link, directUrl, container, { compactText, normalizeHttpsUrl }) {
    const url = unwrapLinkedInExternalUrl(directUrl, normalizeHttpsUrl);
    if (!url) return null;
    const contentRoot = container.querySelector('[data-testid="expandable-text-box"]');
    if (contentRoot?.contains?.(link)) return null;
    const images = [...link.querySelectorAll("img")].sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
    const rect = link.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const lines = String(link.innerText ?? "")
      .split(/\n+/)
      .map((line) => compactText(line))
      .filter(Boolean);
    const domain = new URL(url).hostname.replace(/^www\./i, "");
    const details = lines.filter((line) =>
      !/^https?:\/\//i.test(line) &&
      line.toLowerCase() !== domain.toLowerCase() &&
      !/^(?:learn more|visit website|open link)$/i.test(line),
    );
    const cardSized = rect.width >= 180 && rect.height >= 40;
    if (!cardSized && images.length === 0 && details.length < 2) return null;
    const title = details[0] || images[0]?.alt || domain;
    return {
      kind: "link_preview",
      title: compactText(title).slice(0, 300),
      subtitle: compactText(details[1] || "").slice(0, 300),
      detail: compactText(details[2] || "").slice(0, 300),
      actionLabel: "Open link",
      url,
      domain,
      imageUrl: linkedInThumbnailUrl(images[0]?.currentSrc || images[0]?.src, normalizeHttpsUrl),
    };
  }

  function unwrapLinkedInExternalUrl(value, normalizeHttpsUrl) {
    try {
      const url = new URL(value);
      const linkedInHost = url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
      if (!linkedInHost) return normalizeHttpsUrl(url.href);
      if (!/^\/safety\/go\/?$/i.test(url.pathname)) return null;
      const target = normalizeHttpsUrl(url.searchParams.get("url"));
      if (!target) return null;
      const targetURL = new URL(target);
      if (targetURL.hostname === "linkedin.com" || targetURL.hostname.endsWith(".linkedin.com")) return null;
      return targetURL.href;
    } catch {
      return null;
    }
  }

  function linkedInThumbnailUrl(value, normalizeHttpsUrl) {
    const normalized = normalizeHttpsUrl(value);
    if (!normalized) return null;
    try {
      const url = new URL(normalized);
      return url.hostname === "media.licdn.com" || url.hostname.endsWith(".licdn.com")
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function stripExpansionControl(value) {
    return String(value ?? "")
      .replace(/(?:\s+|^)(?:…\s*)?(?:show |see )?(?:more|less)$/i, "")
      .trim();
  }
})();
