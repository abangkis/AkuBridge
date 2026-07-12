(() => {
  const runtimeRevision = "x-source-presentation-v3";
  if (globalThis.__akuBrowserSourceBridgeRevision === runtimeRevision) return;
  if (globalThis.__akuBrowserSourceBridgeMessageHandler) {
    chrome.runtime.onMessage.removeListener(globalThis.__akuBrowserSourceBridgeMessageHandler);
  }
  globalThis.__akuBrowserSourceBridgeRevision = runtimeRevision;

  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  const sourceAdapters = globalThis.AkuSourceAdapters;
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");
  if (!sourceAdapters) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  const messageHandler = (message, _sender, sendResponse) => {
    if (message?.type === "AKU_BROWSER_PROBE_SOURCE_READY") {
      sendResponse({ ok: true, readiness: probeSourceReadiness(message.source) });
      return false;
    }
    if (message?.type !== "AKU_BROWSER_COLLECT_VISIBLE") return undefined;
    collectBoundedObservation(message.payload)
      .then((observation) => sendResponse({ ok: true, observation }))
      .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
    return true;
  };
  globalThis.__akuBrowserSourceBridgeMessageHandler = messageHandler;
  chrome.runtime.onMessage.addListener(messageHandler);

  function probeSourceReadiness(source) {
    if (!sourceMatchesPage(source)) {
      return readiness("wrong_page", source, 0, 0, false, false);
    }
    const adapter = sourceAdapters.get(source);
    const loginRequired = adapter.loginRequired?.() === true;
    const discovery = discoverSourceCandidates(source);
    const candidates = discovery.candidates;
    const loading = Boolean(document.querySelector(
      '[aria-busy="true"], .artdeco-loader, [data-test-id*="loading" i]',
    ));
    const feedRoot = adapter.feedRootPresent?.() === true;
    const scrollContext = getScrollContext(source, candidates);
    const visibleCandidates = candidates.filter((element) =>
      isVisibleInViewport(element, scrollContext),
    );
    const windowVisibleCandidates = candidates.filter((element) =>
      isVisibleInViewport(element, window),
    );
    const state = loginRequired
      ? "login_required"
      : visibleCandidates.length > 0
        ? "feed_ready"
        : loading || document.readyState !== "complete"
          ? "loading"
          : candidates.length > 0
            ? "feed_not_visible"
          : feedRoot
            ? "selector_mismatch"
            : "page_shell";
    return readiness(
      state,
      source,
      candidates.length,
      visibleCandidates.length,
      loading,
      feedRoot,
      describeScrollContext(scrollContext),
      windowVisibleCandidates.length,
      discovery.semanticCandidateCount,
      discovery.actionAnchoredCandidateCount,
    );
  }

  function readiness(
    state,
    source,
    selectorCandidateCount,
    visibleSelectorCandidateCount,
    loadingIndicator,
    feedRootPresent,
    scrollContext = "window",
    windowVisibleSelectorCandidateCount = 0,
    semanticSelectorCandidateCount = 0,
    actionAnchoredCandidateCount = 0,
  ) {
    return {
      state,
      source,
      selectorCandidateCount,
      visibleSelectorCandidateCount,
      loadingIndicator,
      feedRootPresent,
      scrollContext,
      windowVisibleSelectorCandidateCount,
      semanticSelectorCandidateCount,
      actionAnchoredCandidateCount,
      documentReadyState: document.readyState,
      checkedAt: new Date().toISOString(),
    };
  }

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
    const restorePosition = readScrollPosition(scrollContext);
    if (plan.continuation) {
      scrollToContext(scrollContext, {
        x: restorePosition.x,
        y: plan.continuation.startScrollY,
      });
      await delay(plan.continuation.settleMs);
    }
    const captureStartPosition = readScrollPosition(scrollContext);
    const snapshots = [];
    const uniqueCandidates = new Set();
    const scrollDeltas = [];
    let performedScrolls = 0;
    let scrollStopReason = plan.scrolls === 0 ? "not_requested" : "budget_exhausted";
    let restoreAttempted = false;
    let restored = false;
    let continuationAnchorMatched = false;
    try {
      for (let index = 0; index <= plan.scrolls; index += 1) {
        const snapshot = await captureVisibleSnapshot(source, plan, scrollContext);
        snapshot.index = index;
        if (index === 0 && plan.continuation) {
          continuationAnchorMatched = snapshotMatchesContinuation(
            snapshot,
            plan.continuation.anchorKeys,
          );
          if (!continuationAnchorMatched) {
            throw new Error(
              `The ${source} follow-up frontier no longer matched the prior observation.`,
            );
          }
        }
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
        restored = await restoreScrollContext(scrollContext, restorePosition);
      }
    }

    const candidateCount = uniqueCandidates.size;
    const observedBlockCount = snapshots.reduce((sum, snapshot) => sum + snapshot.blocks.length, 0);
    const fieldCoverage = summarizeFieldCoverage(snapshots);
    const lastSnapshot = snapshots.at(-1);
    const frontierAnchorKeys = (lastSnapshot?.blocks ?? []).map(blockIdentity).filter(Boolean).slice(0, 20);
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
        adapterVersion: sourceAdapters.get(source).version,
        adapterCapabilities: sourceAdapters.capabilities(),
        adapterHealth: {
          state: candidateCount > 0 ? "healthy" : "selector_mismatch",
          strategies: [...new Set(snapshots.map((snapshot) => snapshot.selectorStrategy))],
          selectorCounts: snapshots.at(-1)?.selectorCounts ?? {},
          fieldCoverage,
          domSignature: snapshots.map((snapshot) =>
            `${snapshot.selectorStrategy}:${snapshot.selectorCandidateCount}:${snapshot.visibleContainerCount}`
          ).join("|"),
        },
        frontier: {
          scrollY: lastSnapshot?.scrollY ?? captureStartPosition.y,
          anchorKeys: frontierAnchorKeys,
          newCandidateCount: lastSnapshot?.newCandidateCount ?? 0,
          hasMoreCandidateSignal:
            scrollStopReason === "budget_exhausted" && (lastSnapshot?.newCandidateCount ?? 0) > 0,
        },
        sourceEvents: sourceEvents({
          pendingNewContentSignal,
          pendingNewContentAction,
          candidateCount,
        }),
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
        acquisitionRound: plan.acquisitionRound,
        continuationRequested: Boolean(plan.continuation),
        continuationAnchorMatched,
        captureStartScrollY: Math.round(captureStartPosition.y),
        requestedScrolls: plan.scrolls,
        performedScrolls,
        snapshotCount: snapshots.length,
        scrollDeltas,
        scrollStopReason,
        originalScrollY: Math.round(restorePosition.y),
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
                ? `Scroll position restored to the post-reveal baseline at ${Math.round(restorePosition.y)}; the pre-run feed view at ${Math.round(preActionPosition.y)} was intentionally replaced.`
                : `Scroll position restored to ${Math.round(restorePosition.y)}.`
              : `Scroll restoration was attempted but ended at ${finalScrollY}.`
            : "Scroll restoration was not requested.",
          pendingNewContentSignal
            ? pendingNewContentAction === "activated"
              ? `Pending new content signal activated in the same source tab: ${pendingNewContentSignal.label}.`
              : `Pending new content signal detected: ${pendingNewContentSignal.label}. It was not activated.`
            : "No pending new content signal was detected.",
          plan.continuation
            ? `Provider-directed follow-up started at ${Math.round(captureStartPosition.y)} and matched a prior-observation frontier anchor.`
            : "Initial acquisition round; no continuation frontier was requested.",
          ...snapshots.map(
            (snapshot) =>
              `${snapshot.adapterVersion}: ${snapshot.selectorCandidateCount} selector candidate(s), ${snapshot.visibleContainerCount} visible, ${snapshot.newCandidateCount} new.`,
          ),
          payload.sourceReadiness
            ? `Source readiness: ${payload.sourceReadiness.state}; ${payload.sourceReadiness.selectorCandidateCount} selector candidate(s) after ${payload.sourceReadiness.waitMs ?? 0}ms.`
            : null,
          payload.tabAcquisition?.opened
            ? "AkuBridge opened one inactive canonical source tab for this initial acquisition."
            : null,
          payload.tabAcquisition?.activatedForReadiness
            ? "The source tab was temporarily activated for bounded feed readiness and the previous tab was restored."
            : null,
          payload.tabAcquisition?.backgroundAtDispatch
            ? "The source tab was in the background when the command was dispatched."
            : null,
          payload.tabAcquisition?.recoveryCount > 0
            ? "AkuBridge discarded one stale initial tab reference and rebound to a newly discovered eligible source tab."
            : null,
        ],
        sourceReadinessState: payload.sourceReadiness?.state ?? null,
        sourceReadinessWaitMs: payload.sourceReadiness?.waitMs ?? 0,
        sourceSelectorCandidateCount:
          payload.sourceReadiness?.selectorCandidateCount ?? 0,
        sourceVisibleSelectorCandidateCount:
          payload.sourceReadiness?.visibleSelectorCandidateCount ?? 0,
        sourceLoadingIndicator: payload.sourceReadiness?.loadingIndicator === true,
        sourceFeedRootPresent: payload.sourceReadiness?.feedRootPresent === true,
        sourceTabOpened: payload.tabAcquisition?.opened === true,
        sourceTabActivatedForReadiness:
          payload.tabAcquisition?.activatedForReadiness === true,
        sourceTabBackgroundAtDispatch:
          payload.tabAcquisition?.backgroundAtDispatch === true,
        sourceTabRecoveryCount: payload.tabAcquisition?.recoveryCount ?? 0,
        sourceTabOwnership: payload.tabAcquisition?.ownership ?? "shared",
        sourceTabOpenedDisposition:
          payload.tabAcquisition?.openedTabDisposition ?? "preserve",
        sourceTabClosedAfterCapture: false,
        sourceReadinessRetryCount: payload.sourceReadinessRetryCount ?? 0,
      },
    };
  }

  async function captureVisibleSnapshot(source, payload, scrollContext) {
    const discovery = discoverSourceCandidates(source);
    const selectorCandidates = discovery.candidates;
    const containers = selectorCandidates.filter((element) =>
      isVisibleInViewport(element, scrollContext),
    );

    const recoveredPermalinks = source === "linkedin"
      ? await recoverLinkedInPermalinks(containers.slice(0, payload.maxBlocksPerSnapshot))
      : new WeakMap();

    const blocks = [];
    for (const container of containers) {
      const block = extractBlock(
        container,
        source,
        payload.maxBlockCharacters,
        scrollContext,
        recoveredPermalinks.get(container),
      );
      if (block.text.length < 40) continue;
      if (blocks.some((existing) => existing.text === block.text)) continue;
      block.feedPosition = selectorCandidates.indexOf(container) + 1;
      blocks.push(block);
      if (blocks.length >= payload.maxBlocksPerSnapshot) break;
    }

    return {
      adapterVersion: sourceAdapters.get(source).version ?? "unknown-dom-v1",
      selectorStrategy: discovery.strategy ?? "unknown",
      selectorCounts: discovery.selectorCounts ?? {},
      selectorCandidateCount: selectorCandidates.length,
      visibleContainerCount: containers.length,
      capturedAt: new Date().toISOString(),
      scrollY: Math.round(readScrollPosition(scrollContext).y),
      viewportHeight: Math.round(viewportHeight(scrollContext)),
      blocks,
    };
  }

  function extractBlock(container, source, maxCharacters, scrollContext, recoveredPermalink = null) {
    const text = compactText(container.innerText).slice(0, maxCharacters);
    const time = container.querySelector("time");
    const permalink = findPermalink(container, source, time) ?? recoveredPermalink;
    const adapter = sourceAdapters.get(source);
    const semantics = adapter.extractSemantics(container, {
      compactText,
      normalizeHttpUrl,
    });
    return {
      text,
      author: sourceAdapters.get(source).findAuthor(container, { compactText }),
      avatarUrl: findAvatar(container, source),
      publishedAt: normalizeDate(time?.getAttribute("datetime")),
      permalink,
      platformId: findPlatformId(container, source, permalink),
      contentKind: semantics.contentKind ?? "post",
      relationshipType: semantics.relationshipType ?? "original",
      parentPermalink: normalizeHttpUrl(semantics.parentPermalink),
      engagement: semantics.engagement ?? {},
      media: findMedia(container, source),
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

  async function recoverLinkedInPermalinks(containers) {
    const recovered = new WeakMap();
    for (const container of containers) {
      if (findPermalink(container, "linkedin", container.querySelector("time"))) continue;
      const menuButton = container.querySelector(
        'button[aria-label^="Open control menu for post by"]',
      );
      if (!menuButton) continue;
      menuButton.click();
      await delay(60);
      const embedLink = [...document.querySelectorAll(
        'a[href*="/preload/embed-modal/"][href*="targetUrn="]',
      )].find((link) => isVisibleInViewport(link));
      const canonical = globalThis.AkuLinkedInPermalinkPolicy?.canonicalFromEmbedHref(
        embedLink?.href,
      );
      if (canonical) recovered.set(container, canonical);
      menuButton.click();
      await delay(20);
    }
    return recovered;
  }


  function findAvatar(container, source) {
    const selectors = source === "x"
      ? ['[data-testid="Tweet-User-Avatar"] img', '[data-testid="UserAvatar-Container-unknown"] img']
      : [
          ".update-components-actor__avatar-image",
          ".feed-shared-actor__avatar-image",
          '[data-view-name="feed-actor-image"] img',
          '.update-components-actor img',
          '.feed-shared-actor img',
        ];
    for (const selector of selectors) {
      const image = container.querySelector(selector);
      const url = normalizeHttpUrl(image?.currentSrc || image?.src);
      if (url) return url;
    }
    return null;
  }

  function findMedia(container, source) {
    const candidates = [];
    const adapter = sourceAdapters.get(source);
    for (const image of container.querySelectorAll(adapter.imageSelector ?? "img")) {
      if (adapter.shouldSkipImage?.(image)) continue;
      const rect = image.getBoundingClientRect();
      candidates.push({
        kind: source === "x" && image.closest('[data-testid="previewInterstitial"]')
          ? "video_poster"
          : "image",
        url: image.currentSrc || image.src,
        alt: image.alt || "",
        width: rect.width || image.naturalWidth,
        height: rect.height || image.naturalHeight,
      });
    }
    for (const video of container.querySelectorAll("video[poster]")) {
      const rect = video.getBoundingClientRect();
      candidates.push({
        kind: "video_poster",
        url: video.poster,
        alt: video.getAttribute("aria-label") || "Video preview",
        width: rect.width || video.videoWidth,
        height: rect.height || video.videoHeight,
      });
    }
    if (source === "x") {
      const backgroundElements = container.querySelectorAll([
        '[data-testid="videoPlayer"][style*="background-image"]',
        '[data-testid="videoPlayer"] [style*="background-image"]',
        '[data-testid="videoComponent"][style*="background-image"]',
        '[data-testid="videoComponent"] [style*="background-image"]',
      ].join(","));
      for (const element of backgroundElements) {
        const rect = element.getBoundingClientRect();
        candidates.push({
          kind: "video_poster",
          url: capturePolicy.mediaUrlFromCssBackground(getComputedStyle(element).backgroundImage),
          alt: element.getAttribute("aria-label") || "Video preview",
          width: rect.width,
          height: rect.height,
        });
      }
    }
    return capturePolicy.normalizeMediaCandidates(source, candidates);
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
    const linkedUrl = normalizeHttpUrl(match?.href);
    if (linkedUrl || source !== "linkedin") return linkedUrl;
    const activityId = [
      container.getAttribute("data-urn"),
      container.getAttribute("data-id"),
      ...[...container.querySelectorAll("[data-urn], [data-id]")]
        .slice(0, 20)
        .flatMap((element) => [element.getAttribute("data-urn"), element.getAttribute("data-id")]),
    ].filter(Boolean).map((value) => String(value).match(/activity(?::|-)(\d+)/i)?.[1]).find(Boolean);
    return activityId
      ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
      : null;
  }

  function findPlatformId(container, source, permalink) {
    const candidates = [
      container.getAttribute("data-urn"),
      container.getAttribute("data-id"),
      ...[...container.querySelectorAll("[data-urn], [data-id]")]
        .slice(0, 10)
        .flatMap((element) => [element.getAttribute("data-urn"), element.getAttribute("data-id")]),
      permalink,
    ].filter(Boolean);
    return capturePolicy.platformIdFromCandidates(source, candidates);
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

  function getScrollContext(source, knownCandidates = null) {
    if (source !== "linkedin") return window;

    const candidates = knownCandidates ?? discoverSourceCandidates(source).candidates;
    for (const candidate of candidates.slice(0, 5)) {
      const ancestor = nearestScrollableAncestor(candidate);
      if (ancestor) return ancestor;
    }

    let element = document.querySelector('[data-testid="mainFeed"]') || document.querySelector("main");
    while (element) {
      if (isScrollableElement(element)) return element;
      element = element.parentElement;
    }
    const workspace = document.querySelector("#workspace");
    if (isScrollableElement(workspace)) return workspace;
    return window;
  }

  function nearestScrollableAncestor(element) {
    let current = element?.parentElement ?? null;
    while (current) {
      if (isScrollableElement(current)) return current;
      current = current.parentElement;
    }
    return null;
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
    if (scrollContext === window) {
      window.scrollTo(window.scrollX, window.scrollY + top);
      return;
    }
    scrollContext.scrollTop += top;
  }

  function scrollToContext(scrollContext, position) {
    if (scrollContext === window) {
      window.scrollTo(position.x, position.y);
      return;
    }
    scrollContext.scrollLeft = position.x;
    scrollContext.scrollTop = position.y;
  }

  async function restoreScrollContext(scrollContext, position) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scrollToContext(scrollContext, position);
      await delay(150 + attempt * 100);
      if (Math.abs(readScrollPosition(scrollContext).y - position.y) < 2) return true;
    }
    return false;
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
    const pattern = sourceAdapters.get(source).pendingContentPattern;
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
    const candidates = discoverSourceCandidates(source).candidates
      .filter((element) => isVisibleInViewport(element, scrollContext))
      .slice(0, 3);
    return candidates
      .map((element) => compactText(element.innerText).slice(0, 400))
      .filter(Boolean)
      .join("|");
  }

  function snapshotMatchesContinuation(snapshot, anchorKeys) {
    const observed = new Set(snapshot.blocks.map(blockIdentity).filter(Boolean));
    return anchorKeys.some((key) => observed.has(key));
  }

  function blockIdentity(block) {
    if (block?.platformId) return block.platformId;
    if (block?.permalink) return block.permalink;
    return compactText(block?.text).toLowerCase().slice(0, 300);
  }

  function summarizeFieldCoverage(snapshots) {
    const blocks = snapshots.flatMap((snapshot) => snapshot.blocks);
    const fields = ["author", "publishedAt", "permalink", "platformId", "contentKind"];
    return Object.fromEntries(fields.map((field) => [
      field,
      { present: blocks.filter((block) => Boolean(block[field])).length, total: blocks.length },
    ]));
  }

  function sourceEvents({ pendingNewContentSignal, pendingNewContentAction, candidateCount }) {
    const events = [];
    if (pendingNewContentSignal) {
      events.push({
        type: "source_new_content_available",
        state: pendingNewContentAction,
        label: pendingNewContentSignal.label,
      });
    }
    if (candidateCount === 0) events.push({ type: "source_feed_unavailable", state: "observed" });
    return events;
  }

  function discoverSourceCandidates(source) {
    return sourceAdapters.get(source).discoverCandidates({ compactText, uniqueElements });
  }

  function sourceMatchesPage(source) {
    return sourceAdapters.get(source).matchesPage();
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
