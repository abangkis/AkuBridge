(() => {
  if (globalThis.__akuBrowserSourceBridgeInstalled) return;
  globalThis.__akuBrowserSourceBridgeInstalled = true;

  const SOURCE_ADAPTER_VERSIONS = {
    x: "x-dom-v1",
    linkedin: "linkedin-dom-v2",
  };
  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");

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

    const plan = capturePolicy.normalizeCapturePlan(payload);
    const startedAt = performance.now();
    let scrollContext = getScrollContext(source);
    const preActionPosition = readScrollPosition(scrollContext);
    const pendingNewContentSignal = detectPendingNewContent(source);
    let pendingNewContentAction = pendingNewContentSignal ? "not_activated" : "not_detected";
    let pendingContentActivationEvidence = "";
    let feedMutation = false;
    if (pendingNewContentSignal && plan.pendingContentPolicy === "reveal_if_present") {
      const activation = await activatePendingNewContent(
        pendingNewContentSignal,
        source,
        scrollContext,
        plan,
      );
      pendingContentActivationEvidence = activation.evidence;
      pendingNewContentAction = "activated";
      feedMutation = true;
      scrollContext = getScrollContext(source);
      scrollToContext(scrollContext, { x: 0, y: 0 });
      await delay(120);
    }
    const captureStartPosition = readScrollPosition(scrollContext);
    const snapshots = [];
    const uniqueCandidates = new Set();
    const scrollDeltas = [];
    let performedScrolls = 0;
    let scrollStopReason = plan.scrolls === 0 ? "not_requested" : "budget_exhausted";
    let restoreAttempted = false;
    let restored = false;
    try {
      for (let index = 0; index <= plan.scrolls; index += 1) {
        const snapshot = captureVisibleSnapshot(source, plan, scrollContext);
        snapshot.index = index;
        snapshot.newCandidateCount = capturePolicy.countNewCandidates(
          snapshot.blocks,
          uniqueCandidates,
        );
        snapshots.push(snapshot);

        if (index >= plan.scrolls) break;
        if (performance.now() - startedAt >= plan.captureTimeoutMs) {
          scrollStopReason = "deadline";
          break;
        }

        const beforeScrollY = readScrollPosition(scrollContext).y;
        scrollByContext(
          scrollContext,
          Math.max(320, viewportHeight(scrollContext) * plan.scrollFraction),
        );
        await delay(plan.scrollSettleMs);
        const delta = Math.round(readScrollPosition(scrollContext).y - beforeScrollY);
        if (Math.abs(delta) < 2) {
          scrollStopReason = "no_movement";
          break;
        }
        performedScrolls += 1;
        scrollDeltas.push(delta);
      }
    } finally {
      if (plan.restoreScroll) {
        restoreAttempted = true;
        scrollToContext(scrollContext, captureStartPosition);
        await delay(120);
        restored = Math.abs(readScrollPosition(scrollContext).y - captureStartPosition.y) < 2;
      }
    }

    const candidateCount = uniqueCandidates.size;
    const observedBlockCount = snapshots.reduce((sum, snapshot) => sum + snapshot.blocks.length, 0);
    const finalScrollY = Math.round(readScrollPosition(scrollContext).y);
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
        observedBlockCount,
        browserAdapter: "aku-bridge",
        captureMethod: "native_dom",
        fallbackUsed: false,
        scrollContainer: describeScrollContext(scrollContext),
        pendingNewContent: Boolean(pendingNewContentSignal),
        pendingNewContentLabel: pendingNewContentSignal?.label ?? "",
        pendingNewContentAction,
        pendingContentActivationEvidence,
        pendingContentPolicy: plan.pendingContentPolicy,
        feedMutation,
        sameTabMutation: feedMutation,
        restorationScope: feedMutation ? "post_reveal_start" : "pre_run_position",
        preActionScrollY: Math.round(preActionPosition.y),
        requestedScrolls: plan.scrolls,
        performedScrolls,
        snapshotCount: snapshots.length,
        scrollDeltas,
        scrollStopReason,
        originalScrollY: Math.round(captureStartPosition.y),
        finalScrollY,
        restoreAttempted,
        restored,
        elapsedMs: Math.round(performance.now() - startedAt),
        notes: [
          `${snapshots.length} visible viewport snapshot(s).`,
          "No claim of full-feed coverage.",
          plan.scrolls === 0
            ? "No scrolling was requested."
            : `${performedScrolls} of ${plan.scrolls} native scroll(s) performed; stop reason: ${scrollStopReason}.`,
          plan.restoreScroll
            ? restored
              ? feedMutation
                ? `Scroll position restored to the post-reveal baseline at ${Math.round(captureStartPosition.y)}; the pre-run feed view at ${Math.round(preActionPosition.y)} was intentionally replaced.`
                : `Scroll position restored to ${Math.round(captureStartPosition.y)}.`
              : `Scroll restoration was attempted but ended at ${finalScrollY}.`
            : "Scroll restoration was not requested.",
          pendingNewContentSignal
            ? pendingNewContentAction === "activated"
              ? `Pending new content signal activated in the same source tab: ${pendingNewContentSignal.label}.`
              : `Pending new content signal detected: ${pendingNewContentSignal.label}. It was not activated.`
            : "No pending new content signal was detected.",
          ...snapshots.map(
            (snapshot) =>
              `${snapshot.adapterVersion}: ${snapshot.selectorCandidateCount} selector candidate(s), ${snapshot.visibleContainerCount} visible, ${snapshot.newCandidateCount} new.`,
          ),
        ],
      },
    };
  }

  function captureVisibleSnapshot(source, payload, scrollContext) {
    const selectors = sourceSelectors(source);
    const selectorCandidates = uniqueElements(
      selectors.flatMap((selector) => [...document.querySelectorAll(selector)]),
    );
    const containers = selectorCandidates.filter((element) =>
      isVisibleInViewport(element, scrollContext),
    );

    const blocks = [];
    for (const container of containers) {
      const block = extractBlock(container, source, payload.maxBlockCharacters, scrollContext);
      if (block.text.length < 40) continue;
      if (blocks.some((existing) => existing.text === block.text)) continue;
      block.feedPosition = selectorCandidates.indexOf(container) + 1;
      blocks.push(block);
      if (blocks.length >= payload.maxBlocksPerSnapshot) break;
    }

    return {
      adapterVersion: SOURCE_ADAPTER_VERSIONS[source] ?? "unknown-dom-v1",
      selectorCandidateCount: selectorCandidates.length,
      visibleContainerCount: containers.length,
      capturedAt: new Date().toISOString(),
      scrollY: Math.round(readScrollPosition(scrollContext).y),
      viewportHeight: Math.round(viewportHeight(scrollContext)),
      blocks,
    };
  }

  function extractBlock(container, source, maxCharacters, scrollContext) {
    const text = compactText(container.innerText).slice(0, maxCharacters);
    const time = container.querySelector("time");
    const permalink = findPermalink(container, source, time);
    return {
      text,
      author: findAuthor(container, source),
      publishedAt: normalizeDate(time?.getAttribute("datetime")),
      permalink,
      links: [...container.querySelectorAll("a[href]")]
        .filter((element) => isVisibleInViewport(element, scrollContext))
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

  function isVisibleInViewport(element, scrollContext = window) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const viewport =
      scrollContext === window
        ? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
        : scrollContext.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > viewport.top &&
      rect.top < viewport.bottom &&
      rect.right > viewport.left &&
      rect.left < viewport.right
    );
  }

  function getScrollContext(source) {
    if (source !== "linkedin") return window;
    const preferred = document.querySelector("#workspace");
    if (isScrollableElement(preferred)) return preferred;

    let element = document.querySelector('[data-testid="mainFeed"]') || document.querySelector("main");
    while (element) {
      if (isScrollableElement(element)) return element;
      element = element.parentElement;
    }
    return window;
  }

  function isScrollableElement(element) {
    if (!(element instanceof Element)) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return /^(auto|scroll)$/.test(overflowY) && element.scrollHeight > element.clientHeight + 2;
  }

  function readScrollPosition(scrollContext) {
    return scrollContext === window
      ? { x: window.scrollX, y: window.scrollY }
      : { x: scrollContext.scrollLeft, y: scrollContext.scrollTop };
  }

  function scrollByContext(scrollContext, top) {
    scrollContext.scrollBy({ top, behavior: "instant" });
  }

  function scrollToContext(scrollContext, position) {
    scrollContext.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
  }

  function viewportHeight(scrollContext) {
    return scrollContext === window ? window.innerHeight : scrollContext.clientHeight;
  }

  function describeScrollContext(scrollContext) {
    if (scrollContext === window) return "window";
    if (scrollContext.id) return `#${scrollContext.id}`;
    return scrollContext.tagName.toLowerCase();
  }

  function detectPendingNewContent(source) {
    const pattern =
      source === "x"
        ? /^(?:new posts?|show(?: \d+)? posts?)$/i
        : /^(?:new posts?|show new posts?)$/i;
    for (const element of document.querySelectorAll('button,[role="button"]')) {
      if (!isVisibleInViewport(element)) continue;
      const label = compactText(element.innerText || element.textContent);
      if (pattern.test(label)) return { label, element };
    }
    return null;
  }

  async function activatePendingNewContent(signal, source, scrollContext, plan) {
    if (!signal.element?.isConnected || typeof signal.element.click !== "function") {
      throw new Error("The pending new-content control was no longer available.");
    }

    const beforeFingerprint = visibleFeedFingerprint(source, scrollContext);
    signal.element.click();
    const deadline = Date.now() + plan.pendingContentTimeoutMs;
    let changed = false;
    let evidence = "";
    while (Date.now() < deadline) {
      await delay(100);
      const currentContext = getScrollContext(source);
      const afterFingerprint = visibleFeedFingerprint(source, currentContext);
      if (capturePolicy.hasChangedVisibleFeed(beforeFingerprint, afterFingerprint)) {
        changed = true;
        evidence = "feed_fingerprint_changed";
        break;
      }
    }
    if (!changed) {
      throw new Error(
        `The ${source} pending-content control did not reveal a changed, visible feed within the bounded deadline.`,
      );
    }
    await delay(plan.pendingContentSettleMs);
    if (!sourceMatchesPage(source)) {
      throw new Error(`The ${source} pending-content action left the approved source page.`);
    }
    return { evidence };
  }

  function visibleFeedFingerprint(source, scrollContext) {
    const candidates = uniqueElements(
      sourceSelectors(source).flatMap((selector) => [...document.querySelectorAll(selector)]),
    )
      .filter((element) => isVisibleInViewport(element, scrollContext))
      .slice(0, 3);
    return candidates
      .map((element) => compactText(element.innerText).slice(0, 400))
      .filter(Boolean)
      .join("|");
  }

  function sourceSelectors(source) {
    return source === "x"
      ? ['article[data-testid="tweet"]', 'main article']
      : [
          '[data-testid="mainFeed"] [role="listitem"]',
          '[data-view-name="feed-full-update"]',
          '.feed-shared-update-v2',
          'main article',
        ];
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
