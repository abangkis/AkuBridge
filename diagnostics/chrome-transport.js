(() => {
  if (globalThis.AkuChromeDiagnostics) return;
  // Sampling is best-effort. The controller owns the independent capture timer.
  function createSampler({ read, project, schedule, cancel, delayMs }) {
    let disposed = false, latest = null;
    const timer = schedule(() => {
      try {
        void Promise.resolve(read()).then(value => {
          if (!disposed) latest = project(value);
        }).catch(() => undefined);
      } catch { /* A receiver failure cannot affect the operation. */ }
    }, delayMs);
    return Object.freeze({
      latest: () => latest,
      dispose() { disposed = true; latest = null; cancel(timer); },
    });
  }
  const own = (value, key) => value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const documentIdValid = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  function createAttemptCache({ extensionId, sourceForUrl, project, validAttempt, now }) {
    const entries = new Map();
    const live = entry => entries.get(entry.id) === entry && now() - entry.startedAt < 120_000;
    function accept(entry, message) {
      const sequence = own(message, "sequence"), progress = project(own(message, "progress"));
      if (!live(entry) || entry.terminal || !Number.isSafeInteger(sequence) || sequence <= entry.sequence || sequence > 1_000_000 ||
          !progress || progress.source !== entry.source) return false;
      if (sequence !== entry.sequence + 1) entry.gap = true;
      entry.sequence = sequence;
      entry.latest = progress;
      entry.terminal = progress.stage === "capture_completed";
      entry.complete = progress.stage === "capture_completed" && !entry.gap;
      return true;
    }
    return Object.freeze({
      begin({ id, tabId, source }) {
        for (const entry of entries.values()) if (!live(entry)) entries.delete(entry.id);
        if (!validAttempt(id) || !Number.isInteger(tabId) || entries.has(id) || entries.size >= 32) throw Error("Diagnostic capacity unavailable.");
        const entry = { id, tabId, source, documentId: null, startedAt: now(), sequence: 0, gap: false, complete: false, terminal: false, latest: null };
        entries.set(id, entry);
        return Object.freeze({
          bind(documentId) {
            if (!live(entry) || !documentIdValid(documentId) || entry.documentId && entry.documentId !== documentId) return false;
            entry.documentId = documentId; return true;
          },
          documentId: () => live(entry) ? entry.documentId : null,
          latest: () => live(entry) ? entry.latest : null,
          pull(response) {
            if (!live(entry) || !entry.documentId || own(response, "attemptId") !== id) return null;
            accept(entry, { sequence: own(response, "sequence"), progress: own(response, "diagnostics") });
            return entry.latest;
          },
          state: () => ({ sequence: entry.sequence, deliveryComplete: entry.complete, gap: entry.gap }),
          dispose() { entries.delete(id); entry.latest = null; },
        });
      },
      receive(message, sender) {
        try {
          if (own(message, "schemaVersion") !== 1 || sender.id !== extensionId || sender.frameId !== 0) return false;
          const entry = entries.get(own(message, "attemptId"));
          if (!entry || !entry.documentId || sender.documentId !== entry.documentId || sender.tab?.id !== entry.tabId ||
              sourceForUrl(sender.url) !== entry.source) return false;
          return accept(entry, message);
        } catch { return false; }
      },
    });
  }
  function createPublisher({ attemptId, validAttempt, project, send, dropped = () => {} }) {
    if (!validAttempt(attemptId)) throw Error("Invalid diagnostic correlation.");
    let disposed = false, sending = false, pending = null, count = 0;
    function noteDrop() { try { dropped(); } catch { /* No diagnostic callback has operation authority. */ } }
    function pump() {
      if (disposed || sending || !pending) return;
      if (count >= 64) { pending = null; noteDrop(); return; }
      const message = pending; pending = null; count++; sending = true;
      try {
        void Promise.resolve(send(message)).then(response => {
          if (response?.ok !== true) noteDrop();
        }).catch(() => { noteDrop(); }).finally(() => {
          sending = false; if (!disposed) pump();
        });
      } catch { sending = false; noteDrop(); }
    }
    return Object.freeze({
      publish(sequence, value) {
        try {
          if (disposed) return;
          const progress = project(value);
          if (!progress || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 1_000_000) return;
          if (pending) noteDrop();
          pending = { type: "AKU_BROWSER_CAPTURE_PROGRESS", schemaVersion: 1, attemptId, sequence, progress };
          pump();
        } catch { /* Diagnostic projection cannot stop capture. */ }
      },
      dispose() { disposed = true; pending = null; },
    });
  }
  globalThis.AkuChromeDiagnostics = Object.freeze({ createSampler, createAttemptCache, createPublisher });
})();
