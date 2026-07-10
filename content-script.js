(() => {
  if (globalThis.__akuBrowserSourceBridgeInstalled) return;
  globalThis.__akuBrowserSourceBridgeInstalled = true;

  const SOURCE_ADAPTER_VERSIONS = {
    x: "x-dom-v1",
    linkedin: "linkedin-dom-v2",
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "AKU_BROWSER_COLLECT_VISIBLE") return undefined;
    collectBoundedObservation(message.payload)
      .then((observation) => sendResponse({ ok: true, observation }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  });

  async function collectBoundedObservation(payload) {
    const source = payload.source;
    if (!sourceMatchesPage(source)) {
      throw new Error(`The active source page does not match ${source}.`);
    }

    const originalPosition = { x: window.scrollX, y: window.scrollY };
    const snapshots = [];
    try {
      for (let index = 0; index <= payload.scrolls; index += 1) {
        snapshots.push(captureVisibleSnapshot(source, payload));
        if (index < payload.scrolls) {
          window.scrollBy({ top: Math.max(320, window.innerHeight * 0.72), behavior: "instant" });
          await delay(700);
        }
      }
    } finally {
      if (payload.restoreScroll) {
        window.scrollTo({ left: originalPosition.x, top: originalPosition.y, behavior: "instant" });
      }
    }

    const candidateCount = snapshots.reduce((sum, snapshot) => sum + snapshot.blocks.length, 0);
    return {
      source,
      pageUrl: window.location.href,
      pageTitle: document.title,
      capturedAt: new Date().toISOString(),
      snapshots,
      coverage: {
        status: candidateCount > 0 ? "partial" : "unavailable",
        checkedThrough: new Date().toISOString(),
        candidateCount,
        notes: [
          `${snapshots.length} visible viewport snapshot(s).`,
          "No claim of full-feed coverage.",
          payload.scrolls === 0 ? "No scrolling was performed." : "Scroll position was restored after capture.",
          ...snapshots.map(
            (snapshot) =>
              `${snapshot.adapterVersion}: ${snapshot.selectorCandidateCount} selector candidate(s), ${snapshot.visibleContainerCount} visible.`,
          ),
        ],
      },
    };
  }

  function captureVisibleSnapshot(source, payload) {
    const selectors =
      source === "x"
        ? ['article[data-testid="tweet"]', 'main article']
        : [
            '[data-testid="mainFeed"] [role="listitem"]',
            '[data-view-name="feed-full-update"]',
            '.feed-shared-update-v2',
            'main article',
          ];
    const selectorCandidates = uniqueElements(
      selectors.flatMap((selector) => [...document.querySelectorAll(selector)]),
    );
    const containers = selectorCandidates.filter(isVisibleInViewport);

    const blocks = [];
    for (const container of containers) {
      const block = extractBlock(container, source, payload.maxBlockCharacters);
      if (block.text.length < 40) continue;
      if (blocks.some((existing) => existing.text === block.text)) continue;
      blocks.push(block);
      if (blocks.length >= payload.maxBlocksPerSnapshot) break;
    }

    return {
      adapterVersion: SOURCE_ADAPTER_VERSIONS[source] ?? "unknown-dom-v1",
      selectorCandidateCount: selectorCandidates.length,
      visibleContainerCount: containers.length,
      capturedAt: new Date().toISOString(),
      scrollY: Math.round(window.scrollY),
      viewportHeight: Math.round(window.innerHeight),
      blocks,
    };
  }

  function extractBlock(container, source, maxCharacters) {
    const text = compactText(container.innerText).slice(0, maxCharacters);
    const time = container.querySelector("time");
    const permalink = findPermalink(container, source, time);
    return {
      text,
      author: findAuthor(container, source),
      publishedAt: normalizeDate(time?.getAttribute("datetime")),
      permalink,
      links: [...container.querySelectorAll("a[href]")]
        .filter(isVisibleInViewport)
        .map((anchor) => ({
          text: compactText(anchor.innerText).slice(0, 300),
          href: normalizeHttpUrl(anchor.href),
        }))
        .filter((link) => link.href)
        .filter((link, index, all) => all.findIndex((candidate) => candidate.href === link.href) === index)
        .slice(0, 10),
    };
  }

  function findAuthor(container, source) {
    const selectors =
      source === "x"
        ? ['[data-testid="User-Name"]']
        : ['.update-components-actor__name', '.feed-shared-actor__name', '[data-view-name="feed-actor-image"]'];
    for (const selector of selectors) {
      const value = compactText(container.querySelector(selector)?.innerText).slice(0, 300);
      if (value) return value;
    }
    return "";
  }

  function findPermalink(container, source, time) {
    const timedLink = time?.closest("a[href]")?.href;
    if (normalizeHttpUrl(timedLink)) return normalizeHttpUrl(timedLink);
    const anchors = [...container.querySelectorAll("a[href]")];
    const match = anchors.find((anchor) =>
      source === "x"
        ? /\/status\/\d+/.test(anchor.pathname)
        : /\/feed\/update\//.test(anchor.pathname) || /activity-\d+/.test(anchor.href),
    );
    return normalizeHttpUrl(match?.href);
  }

  function isVisibleInViewport(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function sourceMatchesPage(source) {
    if (source === "x") return window.location.hostname === "x.com";
    return source === "linkedin" && window.location.hostname === "www.linkedin.com";
  }

  function normalizeHttpUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function normalizeDate(value) {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  function compactText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function uniqueElements(values) {
    return [...new Set(values)];
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
