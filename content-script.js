(() => {
  const runtimeRevision = "source-fidelity-v46";
  const LINKEDIN_PERMALINK_RECOVERY_BUDGET_MS = 2_000;
  const LINKEDIN_PERMALINK_RECOVERY_INTERVAL_MS = 50;
  const LINKEDIN_MAX_BLOCKS_PER_SNAPSHOT = 8;
  const CAPTURE_DEADLINE_RESERVE_MS = 2_000;
  if (globalThis.__akuBrowserSourceBridgeRevision === runtimeRevision) return;
  if (globalThis.__akuBrowserSourceBridgeMessageHandler) {
    chrome.runtime.onMessage.removeListener(globalThis.__akuBrowserSourceBridgeMessageHandler);
  }
  globalThis.__akuBrowserSourceBridgeRevision = runtimeRevision;

  const capturePolicy = globalThis.AkuBoundedCapturePolicy;
  const qualityPolicy = globalThis.AkuCaptureQualityPolicy;
  const sourceAdapters = globalThis.AkuSourceAdapters;
  const freshnessRuntime = globalThis.AkuSourceFreshnessRuntime;
  const mediaRecoveryRuntime = globalThis.AkuMediaRecoveryRuntime;
  if (!capturePolicy) throw new Error("AkuBridge bounded-capture policy was not loaded.");
  if (!qualityPolicy) throw new Error("AkuBridge capture-quality policy was not loaded.");
  if (!sourceAdapters) throw new Error("AkuBridge source-adapter runtime was not loaded.");
  if (!freshnessRuntime) throw new Error("AkuBridge source-freshness runtime was not loaded.");
  if (!mediaRecoveryRuntime) throw new Error("AkuBridge media-recovery runtime was not loaded.");
  updateCaptureProgress("idle");

  const messageHandler = (message, _sender, sendResponse) => {
    if (message?.type === "AKU_BROWSER_CAPTURE_DIAGNOSTICS") {
      sendResponse({ ok: true, diagnostics: globalThis.__akuBrowserCaptureProgress });
      return false;
    }
    if (message?.type === "AKU_BROWSER_PROBE_SOURCE_READY") {
      sendResponse({ ok: true, readiness: probeSourceReadiness(message.source) });
      return false;
    }
    if (message?.type === "AKU_BROWSER_PROBE_SOURCE_FRESHNESS") {
      sendResponse({ ok: true, freshness: freshnessRuntime.probe(message.source) });
      return false;
    }
    if (message?.type === "AKU_BROWSER_REVEAL_PENDING_CONTENT") {
      freshnessRuntime.reveal(message.source, message.options)
        .then((freshness) => sendResponse({ ok: true, freshness }))
        .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }));
      return true;
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
    const visualHydration = summarizeVisualHydration(source, visibleCandidates);
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
      visualHydration,
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
    visualHydration = {},
  ) {
    return {
      runtimeRevision,
      adapterRuntimeRevision: sourceAdapters.runtimeRevision,
      adapterVersion: sourceAdapters.get(source).version,
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
      ...visualHydration,
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
    updateCaptureProgress("capture_started", { source, scrolls: plan.scrolls });
    const startedAt = performance.now();
    const operationDeadlineAtMs = Date.now() + Math.max(
      1_000,
      plan.captureTimeoutMs - CAPTURE_DEADLINE_RESERVE_MS,
    );
    let scrollContext = getScrollContext(source);
    const sourceFreshness = payload.sourceFreshness ?? await recoverActiveTabFreshness(source, plan);
    const currentPosition = readScrollPosition(scrollContext);
    const preActionPosition = {
      x: currentPosition.x,
      y: sourceFreshness.feedMutation && Number.isFinite(sourceFreshness.preActionScrollY)
        ? sourceFreshness.preActionScrollY
        : currentPosition.y,
    };
    const pendingNewContentSignal = sourceFreshness.pendingContentDetected
      ? { label: sourceFreshness.pendingContentLabel }
      : null;
    const pendingNewContentAction = sourceFreshness.pendingContentAction;
    const pendingContentActivationEvidence = sourceFreshness.feedMutation
      ? sourceFreshness.evidence
      : "";
    const feedMutation = sourceFreshness.feedMutation === true;
    if (feedMutation) {
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
        if (index > 0 && Date.now() >= operationDeadlineAtMs) {
          scrollStopReason = "deadline";
          break;
        }
        updateCaptureProgress("snapshot_started", { source, snapshotIndex: index });
        const snapshot = await captureVisibleSnapshot(
          source,
          plan,
          scrollContext,
          operationDeadlineAtMs,
        );
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
        updateCaptureProgress("snapshot_completed", {
          source,
          snapshotIndex: index,
          blockCount: snapshot.blocks.length,
        });

        if (index >= plan.scrolls) break;
        if (performance.now() - startedAt >= plan.captureTimeoutMs) {
          scrollStopReason = "deadline";
          break;
        }

        const beforeScrollY = readScrollPosition(scrollContext).y;
        updateCaptureProgress("scrolling", { source, afterSnapshotIndex: index });
        scrollByContext(
          scrollContext,
          Math.max(320, viewportHeight(scrollContext) * plan.scrollFraction),
        );
        updateCaptureProgress("scroll_settling", {
          source,
          afterSnapshotIndex: index,
          milliseconds: plan.scrollSettleMs,
        });
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
        updateCaptureProgress("restoring_scroll", { source });
        restoreAttempted = true;
        restored = await restoreScrollContext(scrollContext, restorePosition);
      }
    }

    const candidateCount = uniqueCandidates.size;
    const observedBlockCount = snapshots.reduce((sum, snapshot) => sum + snapshot.blocks.length, 0);
    const fieldCoverage = summarizeFieldCoverage(snapshots);
    const captureQuality = qualityPolicy.summarize(
      snapshots.flatMap((snapshot) => snapshot.qualityReports ?? []),
      { retryBudget: plan.qualityRetryBudget },
    );
    const mediaRecovery = mediaRecoveryRuntime.summarize(
      snapshots.flatMap((snapshot) => snapshot.blocks ?? []).map((block) => block.mediaRecovery),
    );
    const lastSnapshot = snapshots.at(-1);
    const frontierAnchorKeys = (lastSnapshot?.blocks ?? []).map(blockIdentity).filter(Boolean).slice(0, 20);
    const finalScrollY = Math.round(readScrollPosition(scrollContext).y);
    updateCaptureProgress("capture_completed", { source, observedBlockCount });
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
          state: candidateCount === 0
            ? "selector_mismatch"
            : captureQuality.verdict === "complete"
              ? "healthy"
              : "degraded",
          strategies: [...new Set(snapshots.map((snapshot) => snapshot.selectorStrategy))],
          selectorCounts: snapshots.at(-1)?.selectorCounts ?? {},
          fieldCoverage,
          domSignature: snapshots.map((snapshot) =>
            `${snapshot.selectorStrategy}:${snapshot.selectorCandidateCount}:${snapshot.visibleContainerCount}`
          ).join("|"),
        },
        captureQuality,
        mediaRecovery,
        sourceFreshness,
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
        fallbackUsed: mediaRecovery.outcomes.recovered > 0,
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
          payload.sourceReadiness?.visualHydrationRequired
            ? `Source visual hydration: ${payload.sourceReadiness.visualHydrationReady ? "ready" : "incomplete"}; ${payload.sourceReadiness.hydratedPrimaryAvatarCount ?? 0}/${payload.sourceReadiness.primaryAvatarContainerCount ?? 0} primary avatar(s), ${payload.sourceReadiness.hydratedMediaContainerCount ?? 0}/${payload.sourceReadiness.mediaContainerCount ?? 0} media container(s).`
            : null,
          `Capture quality: ${captureQuality.verdict}; ${captureQuality.candidateReportCount} candidate report(s), ${captureQuality.retryAttempts} bounded retry attempt(s).`,
          `Media recovery: ${mediaRecovery.outcomes.recovered} recovered, ` +
            `${mediaRecovery.outcomes.unavailable} unavailable, ${mediaRecovery.attempts} bounded attempt(s).`,
          payload.tabAcquisition?.opened
            ? "AkuBridge opened one inactive canonical source tab for this initial acquisition."
            : null,
          payload.tabAcquisition?.activatedForReadiness
            ? "The source tab was temporarily activated for bounded feed readiness and the previous tab was restored."
            : null,
          payload.tabAcquisition?.backgroundAtDispatch
            ? "The source tab was in the background when the command was dispatched."
            : null,
          `Source freshness: ${sourceFreshness.outcome}; verification=${sourceFreshness.verification}; ` +
            `wake=${sourceFreshness.wakeAttempted}; probes=${sourceFreshness.probeCount}.`,
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
        sourceVisualHydrationRequired:
          payload.sourceReadiness?.visualHydrationRequired === true,
        sourceVisualHydrationReady:
          payload.sourceReadiness?.visualHydrationReady === true,
        sourcePrimaryAvatarContainerCount:
          payload.sourceReadiness?.primaryAvatarContainerCount ?? 0,
        sourceHydratedPrimaryAvatarCount:
          payload.sourceReadiness?.hydratedPrimaryAvatarCount ?? 0,
        sourceMediaContainerCount:
          payload.sourceReadiness?.mediaContainerCount ?? 0,
        sourceHydratedMediaContainerCount:
          payload.sourceReadiness?.hydratedMediaContainerCount ?? 0,
        sourceTabOpened: payload.tabAcquisition?.opened === true,
        sourceTabActivatedForReadiness:
          payload.tabAcquisition?.activatedForReadiness === true,
        sourceTabBackgroundAtDispatch:
          payload.tabAcquisition?.backgroundAtDispatch === true,
        sourceTabRecoveryCount: payload.tabAcquisition?.recoveryCount ?? 0,
        sourceTabOwnership: payload.tabAcquisition?.ownership ?? "shared",
        sourceTabOpenedDisposition:
          payload.tabAcquisition?.openedTabDisposition ?? "preserve",
        captureVisibilityPolicy:
          payload.tabAcquisition?.captureVisibilityPolicy ?? "quiet",
        captureVisibilityMode:
          payload.tabAcquisition?.captureVisibilityMode ?? "same_window",
        workingTabPreserved: false,
        workingFocusRestored: false,
        sourceTabClosedAfterCapture: false,
        sourceReadinessRetryCount: payload.sourceReadinessRetryCount ?? 0,
      },
    };
  }

  async function captureVisibleSnapshot(source, payload, scrollContext, operationDeadlineAtMs) {
    const capturedAt = new Date().toISOString();
    const discovery = discoverSourceCandidates(source);
    const selectorCandidates = discovery.candidates;
    const containers = selectorCandidates.filter((element) =>
      isVisibleInViewport(element, scrollContext),
    );
    const boundedContainers = containers.slice(
      0,
      source === "linkedin"
        ? Math.min(payload.maxBlocksPerSnapshot, LINKEDIN_MAX_BLOCKS_PER_SNAPSHOT)
        : payload.maxBlocksPerSnapshot,
    );
    updateCaptureProgress("snapshot_candidates_ready", {
      source,
      visibleContainerCount: containers.length,
      boundedContainerCount: boundedContainers.length,
    });

    updateCaptureProgress("permalink_recovery_started", { source });
    const recoveredPermalinks = source === "linkedin"
      ? await recoverLinkedInPermalinks(
          boundedContainers,
          operationDeadlineAtMs,
        )
      : new WeakMap();
    updateCaptureProgress("permalink_recovery_completed", { source });

    const blocks = [];
    const qualityReports = [];
    for (const [containerIndex, container] of boundedContainers.entries()) {
      if (Date.now() >= operationDeadlineAtMs) break;
      updateCaptureProgress("extracting_block", { source, containerIndex });
      const expansion = await expandSourceContent(container, source);
      let block;
      let captureQuality;
      let mediaRecovery;
      let candidateKey;
      try {
        block = extractBlock(
          container,
          source,
          payload.maxBlockCharacters,
          scrollContext,
          recoveredPermalinks.get(container),
          expansion,
          capturedAt,
        );
        candidateKey = provisionalCandidateKey(source, block, containerIndex, capturedAt);
        let qualityAttempt = 0;
        captureQuality = evaluateBlockQuality(
          container,
          source,
          block,
          candidateKey,
          qualityAttempt,
          payload.qualityRetryBudget - qualityAttempt,
        );
        while (
          captureQuality.verdict === "retryable" &&
          qualityAttempt < payload.qualityRetryBudget &&
          Date.now() < operationDeadlineAtMs
        ) {
          const attemptsAvailable = payload.qualityRetryBudget - qualityAttempt;
          qualityAttempt += 1;
          updateCaptureProgress("quality_retry", {
            source,
            containerIndex,
            attempt: qualityAttempt,
          });
          const mediaIssue = captureQuality.issues.some(
            (issue) => issue.field === "media" && issue.recoverable === true,
          );
          if (mediaIssue) {
            const quotedRoot = source === "x" ? findXQuotedPostContainer(container) : null;
            mediaRecovery = await mediaRecoveryRuntime.recover({
              source,
              container,
              excludeRoot: quotedRoot,
              initialMedia: block.media,
              mediaRootDetected: true,
              attemptsAvailable,
              settleMs: payload.qualityRetrySettleMs,
              deadlineAtMs: operationDeadlineAtMs,
              extractPrimary: () => findMedia(container, source, { excludeRoot: quotedRoot }),
              delay,
            });
          } else {
            await delay(payload.qualityRetrySettleMs);
          }
          block = extractBlock(
            container,
            source,
            payload.maxBlockCharacters,
            scrollContext,
            recoveredPermalinks.get(container),
            expansion,
            capturedAt,
          );
          if (mediaRecovery?.media?.length > 0) {
            block.media = capturePolicy.normalizeMediaCandidates(
              source,
              [...block.media, ...mediaRecovery.media],
            );
            if (block.media.some((entry) => entry.kind === "video")) {
              block.contentKind = "video";
            }
          }
          captureQuality = evaluateBlockQuality(
            container,
            source,
            block,
            candidateKey,
            qualityAttempt,
            payload.qualityRetryBudget - qualityAttempt,
          );
        }
        if (captureQuality.verdict === "retryable") {
          captureQuality = evaluateBlockQuality(
            container,
            source,
            block,
            candidateKey,
            captureQuality.attempt,
            0,
          );
        }
        if (!mediaRecovery) {
          mediaRecovery = await mediaRecoveryRuntime.recover({
            source,
            container,
            excludeRoot: source === "x" ? findXQuotedPostContainer(container) : null,
            initialMedia: block.media,
            mediaRootDetected: captureQuality.issues.some((issue) => issue.field === "media"),
            attemptsAvailable: 0,
            settleMs: payload.qualityRetrySettleMs,
            deadlineAtMs: operationDeadlineAtMs,
            extractPrimary: () => block.media,
            delay,
          });
        }
        block.mediaRecovery = mediaRecovery.audit;
        block.captureQuality = captureQuality;
      } finally {
        await restoreSourceContent(expansion);
        if (block?.presentation) block.presentation.contentExpansion = expansion?.state ?? "not_applicable";
      }
      qualityReports.push(captureQuality);
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
      capturedAt,
      scrollY: Math.round(readScrollPosition(scrollContext).y),
      viewportHeight: Math.round(viewportHeight(scrollContext)),
      blocks,
      qualityReports,
    };
  }

  function evaluateBlockQuality(
    container,
    source,
    block,
    candidateKey,
    attempt,
    retriesRemaining,
  ) {
    const adapter = sourceAdapters.get(source);
    const selectors = adapter.qualitySelectors ?? {};
    const quotedRoot = source === "x" ? findXQuotedPostContainer(container) : null;
    const facts = {
      contentRootDetected: selectorDetectedOutside(container, selectors.content, quotedRoot),
      authorRootDetected: selectorDetectedOutside(container, selectors.author, quotedRoot),
      primaryAvatarRootDetected: selectorDetectedOutside(container, selectors.avatar, quotedRoot),
      mediaRootDetected: hasPotentialMediaRoot(container, source, quotedRoot),
      timestampSignalDetected:
        selectorDetectedOutside(container, selectors.timestamp, quotedRoot) ||
        Boolean(block.presentation?.timestampText),
      publishedAtNotExposed:
        block.presentation?.timestampSource === "not_exposed_promoted" ||
        block.presentation?.timestampAvailability === "not_exposed_promoted",
      stableTextIdentity: compactText(block.text).length >= 40,
    };
    return qualityPolicy.evaluateCandidate({
      candidate: block,
      facts,
      profileId: adapter.qualityProfile,
      candidateKey,
      attempt,
      retriesRemaining,
    });
  }

  function provisionalCandidateKey(source, block, containerIndex, capturedAt) {
    if (block?.platformId) return block.platformId;
    if (block?.permalink) return block.permalink;
    const text = compactText(block?.text).toLowerCase();
    if (text) return `${source}:text:${stableTextHash(text)}`;
    return `${source}:dom:${capturedAt}:${containerIndex + 1}`;
  }

  function stableTextHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function selectorDetectedOutside(container, selector, excludeRoot) {
    if (!selector) return false;
    return [...container.querySelectorAll(selector)].some((element) =>
      !excludeRoot?.contains?.(element),
    );
  }

  function hasPotentialMediaRoot(container, source, excludeRoot) {
    const adapter = sourceAdapters.get(source);
    if (selectorDetectedOutside(container, adapter.qualitySelectors?.media, excludeRoot)) {
      return true;
    }
    for (const image of container.querySelectorAll(adapter.imageSelector ?? "img")) {
      if (excludeRoot?.contains?.(image) || adapter.shouldSkipImage?.(image)) continue;
      const rect = image.getBoundingClientRect();
      if ((rect.width || image.naturalWidth) >= 180 && (rect.height || image.naturalHeight) >= 90) {
        return true;
      }
    }
    return [...container.querySelectorAll("video")].some((video) => {
      if (excludeRoot?.contains?.(video)) return false;
      const rect = video.getBoundingClientRect();
      return (rect.width || video.videoWidth) >= 180 && (rect.height || video.videoHeight) >= 90;
    });
  }

  function extractBlock(
    container,
    source,
    maxCharacters,
    scrollContext,
    recoveredPermalink = null,
    contentExpansion = null,
    capturedAt = new Date().toISOString(),
  ) {
    const adapter = sourceAdapters.get(source);
    const text = structuredText(
      adapter.extractText?.(container, { compactText, structuredText }) ?? container,
    ).slice(0, maxCharacters);
    const time = container.querySelector("time");
    const directPermalink = findPermalinkDetails(container, source, time);
    const permalink = directPermalink?.url ?? recoveredPermalink?.url ?? null;
    const semantics = adapter.extractSemantics(container, {
      compactText,
      normalizeHttpUrl,
    });
    const presentation = adapter.extractPresentation?.(container, {
      compactText,
      normalizeHttpUrl,
    }) ?? {};
    const nativePublishedAt = normalizeDate(time?.getAttribute("datetime"));
    const relativeTimestamp = source === "linkedin" && !nativePublishedAt
      ? globalThis.AkuLinkedInTimestampPolicy?.estimateFromRelativeText(
          presentation.timestampText,
          capturedAt,
        ) ?? null
      : null;
    presentation.timestampSource = nativePublishedAt
      ? "native_datetime"
      : relativeTimestamp
        ? "relative_text_estimate"
        : presentation.promoted
          ? "not_exposed_promoted"
          : "unavailable";
    presentation.timestampEstimated = Boolean(relativeTimestamp);
    presentation.timestampPrecision = relativeTimestamp?.precision
      ?? (nativePublishedAt ? "exact" : "unknown");
    const quotedRoot = source === "x" ? findXQuotedPostContainer(container) : null;
    const quotedPost = normalizeQuotedPost(adapter.extractQuotedPost?.(container, {
      compactText,
      normalizeHttpUrl,
      structuredText,
      findMedia: (root) => findMedia(root, source),
    }));
    presentation.permalinkSource = directPermalink?.source ?? recoveredPermalink?.source ?? "unavailable";
    presentation.permalinkReason = permalink
      ? ""
      : recoveredPermalink?.reason ?? "No post permalink or recoverable LinkedIn target URN was exposed.";
    presentation.contentExpansion = contentExpansion?.state ?? "not_applicable";
    const contentRoot = findContentRoot(container, source);
    const media = findMedia(container, source, { excludeRoot: quotedRoot });
    return {
      text,
      author: sourceAdapters.get(source).findAuthor(container, { compactText }),
      avatarUrl: findAvatar(container, source),
      publishedAt: nativePublishedAt ?? relativeTimestamp?.publishedAt ?? null,
      permalink,
      platformId: findPlatformId(container, source, permalink),
      contentKind: media.some((entry) => entry.kind === "video")
        ? "video"
        : semantics.contentKind ?? "post",
      relationshipType: semantics.relationshipType ?? "original",
      parentPermalink: normalizeHttpUrl(semantics.parentPermalink),
      quotedPost,
      engagement: semantics.engagement ?? {},
      presentation,
      media,
      links: [...contentRoot.querySelectorAll("a[href]")]
        .map((anchor) => ({
          text: compactText(anchor.innerText).slice(0, 300),
          href: normalizeHttpUrl(anchor.href),
        }))
        .filter((link) => link.href)
        .filter((link, index, all) => all.findIndex((candidate) => candidate.href === link.href) === index)
        .slice(0, 10),
    };
  }

  function normalizeQuotedPost(value) {
    if (!value || typeof value !== "object") return null;
    const text = structuredText(value.text).slice(0, 4_000);
    if (!text) return null;
    const links = Array.isArray(value.links)
      ? value.links
          .map((link) => ({
            text: compactText(link?.text).slice(0, 300),
            href: normalizeHttpUrl(link?.href),
          }))
          .filter((link) => link.href)
          .slice(0, 10)
      : [];
    return {
      author: compactText(value.author).slice(0, 300),
      avatarUrl: normalizeHttpUrl(value.avatarUrl),
      text,
      permalink: normalizeHttpUrl(value.permalink),
      publishedAt: normalizeDate(value.publishedAt),
      links,
      media: Array.isArray(value.media) ? value.media.slice(0, 4) : [],
    };
  }

  async function recoverLinkedInPermalinks(containers, operationDeadlineAtMs) {
    const recovered = new WeakMap();
    const deadlineAtMs = Math.min(
      Date.now() + LINKEDIN_PERMALINK_RECOVERY_BUDGET_MS,
      operationDeadlineAtMs,
    );
    for (const container of containers) {
      if (findPermalinkDetails(container, "linkedin", container.querySelector("time"))) continue;
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        recovered.set(container, {
          url: null,
          source: "unavailable",
          reason: "LinkedIn permalink recovery budget was exhausted for this snapshot.",
        });
        continue;
      }
      const menuButton = container.querySelector(
        'button[aria-label^="Open control menu for post by"]',
      );
      if (!menuButton) {
        recovered.set(container, { url: null, source: "unavailable", reason: "Post control menu was not exposed." });
        continue;
      }
      const previouslyVisible = new Set(visibleLinkedInPermalinkEvidence().map((entry) => entry.href));
      let opened = false;
      try {
        menuButton.click();
        opened = true;
        const evidence = await waitForValue(
          () => visibleLinkedInPermalinkEvidence().find((entry) => !previouslyVisible.has(entry.href))
            ?? visibleLinkedInPermalinkEvidence()[0]
            ?? null,
          Math.max(1, Math.ceil(remainingMs / LINKEDIN_PERMALINK_RECOVERY_INTERVAL_MS)),
          LINKEDIN_PERMALINK_RECOVERY_INTERVAL_MS,
        );
        const canonical = evidence?.url ?? null;
        recovered.set(container, canonical
          ? { url: canonical, source: evidence.source, reason: "" }
          : { url: null, source: "unavailable", reason: "No stable post URN was exposed after opening the post menu." });
      } finally {
        if (opened) {
          menuButton.click();
          await waitForValue(
            () => visibleLinkedInPermalinkEvidence().length === 0 ? true : null,
            4,
            25,
          );
        }
      }
    }
    return recovered;
  }

  function visibleLinkedInPermalinkEvidence() {
    return [...document.querySelectorAll('[role="menu"] a[href], [role="menu"] [role="menuitem"][href]')]
      .filter((link) => isVisibleInViewport(link))
      .map((link) => ({
        href: link.href,
        url: globalThis.AkuLinkedInPermalinkPolicy?.canonicalFromEvidence(link.href) ?? null,
        source: /\/preload\/embed-modal\//i.test(link.pathname) ? "embed_urn" : "menu_urn",
      }))
      .filter((entry) => entry.url);
  }

  async function expandSourceContent(container, source) {
    if (source === "x") return expandXSourceContent(container);
    if (source !== "linkedin") return { state: "not_applicable" };
    const contentRoot = findContentRoot(container, source);
    const button = contentRoot.querySelector('[data-testid="expandable-text-button"]')
      ?? container.querySelector('[data-testid="expandable-text-button"]');
    const label = compactText(button?.innerText || button?.textContent);
    if (!button || !isExpansionControlLabel(label, "more")) {
      return { state: "already_complete" };
    }
    const before = cleanExpandedText(contentRoot.innerText);
    button.click();
    const expanded = await waitForValue(() => {
      const current = cleanExpandedText(contentRoot.innerText);
      const currentLabel = compactText(button.innerText || button.textContent);
      return current.length > before.length || isExpansionControlLabel(currentLabel, "less")
        ? current
        : null;
    }, 10, 40);
    return {
      state: expanded ? "expanded" : "expand_failed",
      button,
      contentRoot,
      before,
      expanded: Boolean(expanded),
    };
  }

  async function expandXSourceContent(container) {
    const contentRoot = findContentRoot(container, "x");
    const button = container.querySelector('[data-testid="tweet-text-show-more-link"]');
    if (!button) return { state: "already_complete" };
    const before = cleanExpandedText(contentRoot.innerText);
    button.click();
    const expanded = await waitForValue(() => {
      const current = cleanExpandedText(contentRoot.innerText);
      return current.length > before.length && !container.querySelector(
        '[data-testid="tweet-text-show-more-link"]',
      ) ? current : null;
    }, 12, 40);
    return {
      state: expanded ? "expanded_no_restore_control" : "expand_failed",
      contentRoot,
      before,
      expanded: Boolean(expanded),
    };
  }

  async function restoreSourceContent(expansion) {
    if (!expansion?.expanded || !expansion.button) return;
    const label = compactText(expansion.button.innerText || expansion.button.textContent);
    if (isExpansionControlLabel(label, "less")) {
      expansion.button.click();
      const restored = await waitForValue(
        () => cleanExpandedText(expansion.contentRoot.innerText).length <= expansion.before.length
          ? true
          : null,
        8,
        30,
      );
      expansion.state = restored ? "expanded_restored" : "expanded_restore_failed";
    } else {
      expansion.state = "expanded_no_restore_control";
    }
  }

  function isExpansionControlLabel(value, direction) {
    const text = compactText(value).replace(/^…\s*/, "");
    return direction === "more"
      ? /^(?:more|show more|see more)$/i.test(text)
      : /^(?:less|show less|see less)$/i.test(text);
  }

  function cleanExpandedText(value) {
    return compactText(value).replace(/(?:\s+|^)(?:…\s*)?(?:show |see )?(?:more|less)$/i, "").trim();
  }

  function findContentRoot(container, source) {
    const selector = sourceAdapters.get(source).contentRootSelector;
    return selector ? container.querySelector(selector) ?? container : container;
  }


  function findAvatar(container, source) {
    const adapterAvatar = sourceAdapters.get(source).findAvatar?.(container, {
      compactText,
      normalizeHttpUrl,
    });
    if (normalizeHttpUrl(adapterAvatar)) return normalizeHttpUrl(adapterAvatar);
    const selectors = source === "x"
      ? ['[data-testid="Tweet-User-Avatar"] img', '[data-testid^="UserAvatar-Container-"] img']
      : [
          ".update-components-actor__avatar-image",
          ".feed-shared-actor__avatar-image",
          '[data-view-name="feed-actor-image"] img',
          '.update-components-actor img',
          '.feed-shared-actor img',
        ];
    for (const selector of selectors) {
      const image = container.querySelector(selector);
      const url = normalizeHttpUrl(readImageUrl(image));
      if (url) return url;
    }
    if (source === "x") {
      const avatarRoots = container.querySelectorAll(
        '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]',
      );
      for (const avatarRoot of avatarRoots) {
        const url = renderedBackgroundUrl(avatarRoot);
        if (url) return url;
      }
    }
    return null;
  }

  function summarizeVisualHydration(source, candidates) {
    if (source !== "x") {
      return {
        visualHydrationRequired: false,
        visualHydrationReady: true,
        primaryAvatarContainerCount: 0,
        hydratedPrimaryAvatarCount: 0,
        mediaContainerCount: 0,
        hydratedMediaContainerCount: 0,
      };
    }
    let primaryAvatarContainerCount = 0;
    let hydratedPrimaryAvatarCount = 0;
    let mediaContainerCount = 0;
    let hydratedMediaContainerCount = 0;
    for (const container of candidates.slice(0, 20)) {
      const avatarRoot = container.querySelector(
        '[data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container-"]',
      );
      if (avatarRoot) {
        primaryAvatarContainerCount += 1;
        const imageUrl = readImageUrl(avatarRoot.querySelector("img"));
        if (imageUrl || renderedBackgroundUrl(avatarRoot)) {
          hydratedPrimaryAvatarCount += 1;
        }
      }
      const mediaSelector = sourceAdapters.get(source).qualitySelectors?.media;
      const mediaRoot = mediaSelector ? container.querySelector(mediaSelector) : null;
      if (mediaRoot) {
        mediaContainerCount += 1;
        if (findMedia(container, source).length > 0) hydratedMediaContainerCount += 1;
      }
    }
    return {
      visualHydrationRequired: true,
      visualHydrationReady:
        primaryAvatarContainerCount > 0 &&
        hydratedPrimaryAvatarCount === primaryAvatarContainerCount &&
        hydratedMediaContainerCount === mediaContainerCount,
      primaryAvatarContainerCount,
      hydratedPrimaryAvatarCount,
      mediaContainerCount,
      hydratedMediaContainerCount,
    };
  }

  function findMedia(container, source, { excludeRoot = null } = {}) {
    const candidates = [];
    const adapter = sourceAdapters.get(source);
    for (const image of container.querySelectorAll(adapter.imageSelector ?? "img")) {
      if (excludeRoot?.contains?.(image)) continue;
      if (adapter.shouldSkipImage?.(image)) continue;
      const rect = image.getBoundingClientRect();
      const videoRoot = source === "x" ? image.closest(
        '[data-testid="previewInterstitial"], [data-testid="videoPlayer"], '
          + '[data-testid="videoComponent"], [aria-label*="Video" i]',
      ) : null;
      const imageUrl = readImageUrl(image);
      candidates.push({
        kind: videoRoot
          ? "video"
          : source === "x" && /embedded video/i.test(image.alt || "")
            ? "video"
          : "image",
        url: imageUrl,
        posterUrl: imageUrl,
        playbackMode: source === "x" && (videoRoot || /embedded video/i.test(image.alt || ""))
          ? "native"
          : undefined,
        alt: image.alt || "",
        width: rect.width || image.naturalWidth,
        height: rect.height || image.naturalHeight,
      });
    }
    for (const video of container.querySelectorAll("video")) {
      if (excludeRoot?.contains?.(video)) continue;
      const rect = video.getBoundingClientRect();
      const playbackUrl = [
        video.currentSrc,
        video.src,
        ...[...video.querySelectorAll("source[src]")].map((sourceElement) => sourceElement.src),
      ].find((value) => /^https:\/\/video\.twimg\.com\//i.test(value ?? ""));
      const posterUrl = [
        video.poster,
        video.getAttribute("poster"),
        renderedBackgroundUrl(video),
      ].map(normalizeHttpUrl).find(Boolean) ?? null;
      candidates.push({
        kind: "video",
        url: posterUrl,
        posterUrl,
        playbackUrl,
        playbackMode: playbackUrl ? "inline" : "native",
        alt: video.getAttribute("aria-label") || "Video preview",
        width: rect.width || video.videoWidth,
        height: rect.height || video.videoHeight,
      });
    }
    if (source === "x") {
      const photoBackgrounds = container.querySelectorAll(
        '[data-testid="tweetPhoto"] [style*="background-image"]',
      );
      for (const element of photoBackgrounds) {
        if (excludeRoot?.contains?.(element)) continue;
        const rect = element.getBoundingClientRect();
        const url = capturePolicy.mediaUrlFromCssBackground(
          element.style.backgroundImage || getComputedStyle(element).backgroundImage,
        );
        candidates.push({
          kind: "image",
          url,
          alt: element.closest('[data-testid="tweetPhoto"]')?.getAttribute("aria-label") || "Image",
          width: rect.width,
          height: rect.height,
        });
      }
      const linkCardBackgrounds = container.querySelectorAll(
        'a[aria-label][href] [style*="/card_img/"]',
      );
      for (const element of linkCardBackgrounds) {
        if (excludeRoot?.contains?.(element)) continue;
        const rect = element.getBoundingClientRect();
        const url = capturePolicy.mediaUrlFromCssBackground(
          element.style.backgroundImage || getComputedStyle(element).backgroundImage,
        );
        candidates.push({
          kind: "image",
          url,
          alt: element.closest('a[aria-label][href]')?.getAttribute("aria-label") || "Link preview",
          width: rect.width,
          height: rect.height,
        });
      }
      const videoRoots = container.querySelectorAll([
        '[data-testid="videoPlayer"]',
        '[data-testid="videoComponent"]',
        '[aria-label*="Video" i]',
      ].join(","));
      for (const videoRoot of videoRoots) {
        if (excludeRoot?.contains?.(videoRoot)) continue;
        const rect = videoRoot.getBoundingClientRect();
        const posterUrl = renderedBackgroundUrl(videoRoot);
        candidates.push({
          kind: "video",
          url: posterUrl,
          posterUrl,
          playbackMode: "native",
          alt: videoRoot.getAttribute("aria-label") || "Video preview",
          width: rect.width,
          height: rect.height,
        });
      }
    }
    return capturePolicy.normalizeMediaCandidates(source, candidates);
  }

  function findPermalink(container, source, time) {
    return findPermalinkDetails(container, source, time)?.url ?? null;
  }

  function findPermalinkDetails(container, source, time) {
    const timedLink = time?.closest("a[href]")?.href;
    if (normalizeHttpUrl(timedLink)) return { url: normalizeHttpUrl(timedLink), source: "time_anchor" };
    const anchors = [...container.querySelectorAll("a[href]")];
    const match = anchors.find((anchor) =>
      source === "x"
        ? /\/status\/\d+/.test(anchor.pathname)
        : /\/feed\/update\//.test(anchor.pathname) || /activity-\d+/.test(anchor.href),
    );
    const linkedUrl = normalizeHttpUrl(match?.href);
    if (linkedUrl || source !== "linkedin") {
      return linkedUrl ? { url: linkedUrl, source: "direct_anchor" } : null;
    }
    const domEvidence = [
      container.getAttribute("data-urn"),
      container.getAttribute("data-id"),
      ...[...container.querySelectorAll("[data-urn], [data-id]")]
        .slice(0, 20)
        .flatMap((element) => [element.getAttribute("data-urn"), element.getAttribute("data-id")]),
    ].filter(Boolean).map((value) => {
      const canonical = globalThis.AkuLinkedInPermalinkPolicy?.canonicalFromEvidence(String(value));
      if (canonical) return canonical;
      const activityId = String(value).match(/activity(?::|-)(\d+)/i)?.[1];
      return activityId
        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
        : null;
    }).find(Boolean);
    return domEvidence
      ? { url: domEvidence, source: "dom_urn" }
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

  async function recoverActiveTabFreshness(source, plan) {
    const probe = freshnessRuntime.probe(source);
    if (probe.pendingContentDetected && plan.pendingContentPolicy === "reveal_if_present") {
      const revealed = await freshnessRuntime.reveal(source, {
        timeoutMs: plan.pendingContentTimeoutMs,
        settleMs: plan.pendingContentSettleMs,
      });
      return {
        policyVersion: "source-freshness-recovery-v1",
        adapterFreshnessVersion: probe.strategy.version,
        source,
        status: "ready",
        outcome: "pending_content_revealed",
        verification: "feed_change",
        evidence: revealed.evidence,
        backgroundAtDispatch: false,
        opened: false,
        wakeAttempted: false,
        activated: false,
        probeCount: 1,
        pendingContentDetected: true,
        pendingContentLabel: revealed.label,
        pendingContentAction: "activated",
        feedChanged: true,
        feedMutation: true,
        waitMs: 0,
        preActionScrollY: revealed.preActionScrollY,
      };
    }
    return {
      policyVersion: "source-freshness-recovery-v1",
      adapterFreshnessVersion: probe.strategy.version,
      source,
      status: "ready",
      outcome: "active_feed_ready",
      verification: "active_dispatch",
      evidence: "active_at_dispatch",
      backgroundAtDispatch: false,
      opened: false,
      wakeAttempted: false,
      activated: false,
      probeCount: 1,
      pendingContentDetected: probe.pendingContentDetected,
      pendingContentLabel: probe.pendingContentLabel,
      pendingContentAction: probe.pendingContentDetected ? "not_activated" : "not_detected",
      feedChanged: false,
      feedMutation: false,
      waitMs: 0,
      preActionScrollY: probe.scrollY,
    };
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

  function structuredText(value) {
    if (typeof value === "string") return normalizeStructuredWhitespace(value);
    if (!value || typeof value !== "object") return "";
    if (!value.childNodes || value.childNodes.length === 0) {
      return normalizeStructuredWhitespace(value.innerText || value.textContent || "");
    }
    return normalizeStructuredWhitespace(readStructuredNode(value));
  }

  function readStructuredNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "img") return node.getAttribute?.("alt") || "";
    if (tag === "br") return "\n";
    const body = [...(node.childNodes || [])].map(readStructuredNode).join("");
    return ["div", "p", "li", "section", "article"].includes(tag) ? `${body}\n` : body;
  }

  function normalizeStructuredWhitespace(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t\f\v\u00a0 ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readImageUrl(image) {
    return readImageUrls(image).map(normalizeHttpUrl).find(Boolean) ?? null;
  }

  function readImageUrls(image) {
    if (!image) return [];
    const srcsets = [image.srcset, image.getAttribute?.("srcset")].filter(Boolean);
    const srcsetUrls = srcsets.flatMap((srcset) => String(srcset).split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter(Boolean));
    return [...new Set([
      image.currentSrc,
      image.src,
      image.getAttribute?.("src"),
      ...srcsetUrls,
    ].filter(Boolean))];
  }

  function renderedBackgroundUrl(root) {
    if (!root) return null;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const backgroundImage = element.style?.backgroundImage || getComputedStyle(element).backgroundImage;
      const url = normalizeHttpUrl(capturePolicy.mediaUrlFromCssBackground(backgroundImage));
      if (url) return url;
    }
    return null;
  }

  function findXQuotedPostContainer(container) {
    const explicit = container.querySelector('[data-testid="quoteTweet"]');
    if (explicit) return explicit;
    const textRoots = [...container.querySelectorAll('[data-testid="tweetText"]')];
    for (const textRoot of textRoots.slice(1)) {
      const quoted = textRoot.closest?.('[role="link"]');
      if (quoted && quoted !== container) return quoted;
    }
    return null;
  }

  function compactText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function uniqueElements(values) {
    return [...new Set(values)];
  }

  function updateCaptureProgress(stage, details = {}) {
    globalThis.__akuBrowserCaptureProgress = Object.freeze({
      runtimeRevision,
      adapterRuntimeRevision: sourceAdapters.runtimeRevision,
      stage,
      ...details,
      updatedAt: new Date().toISOString(),
    });
  }

  async function delay(milliseconds) {
    const duration = Math.max(0, Math.min(2_000, Math.trunc(Number(milliseconds) || 0)));
    try {
      const response = await chrome.runtime.sendMessage({
        type: "AKU_BROWSER_CAPTURE_DELAY",
        milliseconds: duration,
      });
      if (response?.ok) return;
    } catch {
      // A local timer remains a safe fallback if the extension is reloading.
    }
    await new Promise((resolve) => setTimeout(resolve, duration));
  }

  async function waitForValue(read, attempts, intervalMs) {
    const deadlineAtMs = Date.now() + attempts * intervalMs;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = read();
      if (value) return value;
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) return null;
      await delay(Math.min(intervalMs, remainingMs));
    }
    return read() || null;
  }
})();
