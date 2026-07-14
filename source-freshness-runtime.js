(() => {
  const runtimeRevision = "source-freshness-runtime-v1";
  const sourceAdapters = globalThis.AkuSourceAdapters;
  if (!sourceAdapters) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  function probe(source) {
    const adapter = sourceAdapters.get(source);
    const strategy = adapter.freshness;
    const candidates = adapter.discoverCandidates({ compactText, uniqueElements }).candidates ?? [];
    const visibleCandidates = candidates.filter(isVisibleInWindow).slice(0, 3);
    const pending = detectPendingControl(
      strategy.pendingContentPattern,
      strategy.rejectInsideFeedCandidate ? candidates : [],
    );
    return {
      runtimeRevision,
      source,
      strategy: {
        version: strategy.version,
        wakeWhenBackground: strategy.wakeWhenBackground,
        settledWakeIsCurrent: strategy.settledWakeIsCurrent,
        wakeObservationMs: strategy.wakeObservationMs,
        probeIntervalMs: strategy.probeIntervalMs,
        revealSupported: strategy.revealSupported,
        revealObservationMs: strategy.revealObservationMs,
        rejectInsideFeedCandidate: strategy.rejectInsideFeedCandidate === true,
      },
      documentVisibility: document.visibilityState,
      pendingContentDetected: Boolean(pending),
      pendingContentLabel: pending?.label ?? "",
      feedFingerprint: fingerprint(visibleCandidates),
      visibleCandidateCount: visibleCandidates.length,
      scrollY: Math.round(readScrollY(candidates)),
      checkedAt: new Date().toISOString(),
    };
  }

  async function reveal(source, { timeoutMs = 5_000, settleMs = 700 } = {}) {
    const adapter = sourceAdapters.get(source);
    if (adapter.freshness.revealSupported !== true) {
      throw new Error(`The ${source} adapter does not support pending-content reveal.`);
    }
    const candidates = adapter.discoverCandidates({ compactText, uniqueElements }).candidates ?? [];
    const signal = detectPendingControl(
      adapter.freshness.pendingContentPattern,
      adapter.freshness.rejectInsideFeedCandidate ? candidates : [],
    );
    if (!signal?.element?.isConnected || typeof signal.element.click !== "function") {
      throw new Error("The pending new-content control was no longer available.");
    }
    const before = probe(source);
    signal.element.click();
    const observationMs = Math.max(
      clampInteger(timeoutMs, 500, 15_000, 5_000),
      clampInteger(adapter.freshness.revealObservationMs, 500, 15_000, 5_000),
    );
    const deadline = Date.now() + observationMs;
    let after = before;
    while (Date.now() < deadline) {
      await delay(Math.min(100, deadline - Date.now()));
      after = probe(source);
      if (changed(before.feedFingerprint, after.feedFingerprint)) break;
    }
    if (!changed(before.feedFingerprint, after.feedFingerprint)) {
      throw new Error(
        `The ${source} pending-content control "${signal.label}" did not reveal a changed, visible feed within ${observationMs}ms.`,
      );
    }
    await delay(clampInteger(settleMs, 100, 2_000, 700));
    if (!adapter.matchesPage()) {
      throw new Error(`The ${source} pending-content action left the approved source page.`);
    }
    return {
      evidence: "feed_fingerprint_changed",
      label: signal.label,
      preActionScrollY: before.scrollY,
      postActionScrollY: probe(source).scrollY,
    };
  }

  function detectPendingControl(pattern, feedCandidates = []) {
    for (const element of document.querySelectorAll('button,[role="button"]')) {
      if (!isVisibleInWindow(element)) continue;
      if (feedCandidates.some((candidate) => candidate === element || candidate.contains(element))) {
        continue;
      }
      const label = compactText(element.innerText || element.textContent);
      if (pattern.test(label)) return { label, element };
    }
    return null;
  }

  function fingerprint(candidates) {
    return candidates
      .map((element) => compactText(element.innerText).slice(0, 400))
      .filter(Boolean)
      .join("|");
  }

  function changed(before, after) {
    return Boolean(before && after && before !== after);
  }

  function readScrollY(candidates) {
    for (const candidate of candidates.slice(0, 5)) {
      let current = candidate?.parentElement ?? null;
      while (current) {
        const overflowY = getComputedStyle(current).overflowY;
        if (/^(auto|scroll)$/.test(overflowY) && current.scrollHeight > current.clientHeight + 2) {
          return current.scrollTop;
        }
        current = current.parentElement;
      }
    }
    return window.scrollY;
  }

  function isVisibleInWindow(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
  }

  function compactText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter((element) => element instanceof Element))];
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
  }

  globalThis.AkuSourceFreshnessRuntime = Object.freeze({
    runtimeRevision,
    probe,
    reveal,
  });
})();
