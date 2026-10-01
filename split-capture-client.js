// Optional Windows split transport. Nothing runs until the explicitly launched
// capture-host page supplies its instance capability or that session is restored.
import { BRIDGE_CONTRACT_VERSION, BRIDGE_ID } from "./bridge-capabilities.js";
const SESSION_KEY = "akuWindowsSplitCaptureSession";
export function createSplitCaptureClient({ chrome, fetch: request = globalThis.fetch, handlers, captureHostOnlyRetirement = false, delay = (ms) => new Promise((r) => setTimeout(r, ms)), setInterval: every = globalThis.setInterval, clearInterval: cancelEvery = globalThis.clearInterval, diagnostic = (event) => console.info("aku_split_capture_poll", event) }) {
  let config = null;
  let polling = false;
  let connecting = null;
  let heartbeat = null;
  let activePoll = null;
  function clearHeartbeat() {
    if (heartbeat !== null) cancelEvery(heartbeat);
    heartbeat = null;
  }
  async function stop(c) {
    if (config !== c) return;
    config = null;
    clearHeartbeat();
    activePoll?.abort();
    await chrome.storage.session.remove(SESSION_KEY).catch(() => undefined);
  }
  function startHeartbeat(c) {
    clearHeartbeat();
    let checking = false;
    // Chrome 110+ extension API calls reset the worker idle timer. Bound this
    // to the authenticated host session, independent of page freeze/timers.
    heartbeat = every(() => {
      if (config !== c || checking) return;
      checking = true;
      void (async () => {
        try {
          const tab = await chrome.tabs.get(c.tabId);
          if (config !== c) return;
          if (tab?.url !== `${c.endpoint}/split-capture-host#${c.key}`) {
            await stop(c);
          }
        } catch { await stop(c); }
        finally { checking = false; }
      })().catch(() => undefined);
    }, 20_000);
  }
  const report = (event) => { try { diagnostic(event); } catch { /* Diagnostics cannot interrupt capture. */ } };
  const headers = () => config ? { "X-Aku-Capture-Instance": config.key } : {};
  const bridgeHeaders = (c) => ({
    "Content-Type": "application/json", "X-Aku-Capture-Instance": c.key,
    "X-Aku-Bridge-Token": c.token, "X-Aku-Bridge-Contract": BRIDGE_CONTRACT_VERSION,
    "X-Aku-Bridge-Id": BRIDGE_ID,
  });
  async function execute(action, c, capabilities = {}) {
    let response;
    try {
      const handler = Object.hasOwn(handlers, action.type) ? handlers[action.type] : null;
      if (!handler) throw new Error("Unsupported split capture action.");
      if (action.type === "close_capture_host") {
        if (capabilities.captureHostClose !== true || c.captureHostClose !== true) {
          throw new Error("Capture host close is not negotiated.");
        }
        if (action.hostOnly !== undefined && typeof action.hostOnly !== "boolean") {
          throw new Error("Invalid capture host retirement policy.");
        }
        if (action.hostOnly === true && (captureHostOnlyRetirement !== true ||
            capabilities.captureHostOnlyRetirement !== true || c.captureHostOnlyRetirement !== true)) {
          throw new Error("Host-only capture retirement is not negotiated.");
        }
        if (config !== c) {
          throw new Error("Capture host identity changed.");
        }
        const exactHost = await isExactCaptureHost(c);
        if (config !== c || !exactHost) {
          throw new Error("Capture host identity changed.");
        }
      }
      const context = action.type === "open_native_post" ? {
        ...c,
        readerIntent: {
          url: `${c.endpoint}/split-reader-intent?id=${encodeURIComponent(action.id)}`,
          prepare: () => readerRequest("prepare", action, c),
          foreground: () => readerRequest("foreground", action, c),
        },
      } : action.type === "open_source" && capabilities.sourceWindowLifetime === true ? {
        ...c,
        sourceIntent: {
          url: `${c.endpoint}/split-source-intent?id=${encodeURIComponent(action.id)}`,
          prepare: async () => {
            if (config !== c) throw new Error("Source intent expired.");
            const response = await request(`${c.endpoint}/api/bridge/split-capture/source/prepare/${encodeURIComponent(action.id)}`, {
              method: "POST", headers: bridgeHeaders(c), body: "{}", signal: AbortSignal.timeout(5000),
            });
            if (!response.ok || config !== c) throw new Error("Source window tracking was rejected or expired.");
          },
        },
      } : c;
      // Host-only retirement deliberately bypasses legacy cleanup handlers:
      // ordinary tabs can have become interactive since they were classified.
      const result = action.type === "close_capture_host" && action.hostOnly === true
        ? { retired: { hostOnly: true } }
        : await handler(action, context) ?? {};
      response = { ok: true, result };
    } catch (error) {
      response = { ok: false, message: String(error?.message ?? error).slice(0, 600) };
    }
    // No result/action is retried across a new capture instance or epoch.
    if (config !== c) return;
    const result = await request(`${c.endpoint}/api/bridge/split-capture/results/${encodeURIComponent(action.id)}`, {
      method: "POST", headers: bridgeHeaders(c), body: JSON.stringify(response), signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new Error("Capture result was rejected or expired.");
    if (action.type === "close_capture_host" && response.ok) {
      if (config !== c) return;
      const host = await getExactCaptureHost(c);
      if (config !== c) return;
      if (host) {
        try {
          if (config !== c) return;
          await chrome.tabs.remove(c.tabId);
          report({ phase: "capture_host_closed" });
          await stop(c);
        } catch {
          report({ phase: "capture_host_close_failed" });
        }
      } else {
        report({ phase: "capture_host_missing_or_changed" });
      }
    }
    if (action.type === "reload_self" && response.ok) chrome.runtime.reload();
  }
  async function readerRequest(phase, action, c) {
    if (config !== c || action.type !== "open_native_post") throw new Error("Reader foreground intent expired.");
    const response = await request(`${c.endpoint}/api/bridge/split-capture/reader/${phase}/${encodeURIComponent(action.id)}`, {
      method: "POST", headers: bridgeHeaders(c), body: "{}", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message ?? result?.message ?? "Native reader foreground request was rejected.");
    }
  }
  async function getExactCaptureHost(c) {
    const hostUrl = `${c.endpoint}/split-capture-host#${c.key}`;
    let host;
    try { host = await chrome.tabs.get(c.tabId); } catch { return null; }
    return host?.id === c.tabId && host.url === hostUrl &&
      (!host.pendingUrl || host.pendingUrl === hostUrl) ? host : null;
  }
  async function isExactCaptureHost(c) {
    return (await getExactCaptureHost(c)) !== null;
  }
  async function poll() {
    if (polling || !config) return;
    polling = true;
    try {
      while (config) {
        const c = config;
        const startedAt = performance.now();
        report({ phase: "request_start" });
        try {
          const pollController = new AbortController();
          activePoll = pollController;
          const timeout = setTimeout(() => pollController.abort(new DOMException("Capture poll timed out", "TimeoutError")), 25_000);
          let response;
          try {
            response = await request(`${c.endpoint}/api/bridge/split-capture/next`, {
              headers: bridgeHeaders(c), cache: "no-store", signal: pollController.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
          if (config !== c) continue;
          report({ phase: "response", status: response.status, elapsedMs: Math.round(performance.now() - startedAt) });
          if ([401, 403, 409, 410].includes(response.status)) {
            report({ phase: "poll_stopped", reason: "terminal_status", status: response.status });
            await stop(c); break;
          }
          if (response.status === 204) continue;
          if (!response.ok) throw new Error("Capture action poll failed.");
          const payload = await response.json();
          if (config !== c) continue;
          if (payload.instanceEpoch !== c.instanceEpoch || typeof payload.action?.id !== "string") {
            report({ phase: "poll_stopped", reason: "epoch_or_payload_mismatch" });
            await stop(c); break;
          }
          report({ phase: "action_claimed", actionId: payload.action.id, actionType: payload.action.type });
          // Captures can be long. Keep claiming release/control requests while
          // a bounded capture executes; existing command/lease guards own them.
          if (payload.action.type === "close_capture_host") {
            try { await execute(payload.action, c, payload); }
            catch {
              report({ phase: "action_result_error", actionId: payload.action.id, actionType: payload.action.type });
            }
          } else {
            void execute(payload.action, c, payload).catch(() => undefined);
          }
        } catch (error) {
          if (config !== c) continue;
          report({ phase: "request_error", kind: error?.name === "TimeoutError" ? "timeout" : "other", elapsedMs: Math.round(performance.now() - startedAt) });
          await delay(2000);
        }
      }
    } finally {
      activePoll = null;
      polling = false;
      // A replacement session can connect while an old terminal response is
      // cleaning up; it must get its own poll rather than wait for a page timer.
      if (config) void poll();
    }
  }
  async function connect(message, sender) {
    let url;
    try { url = new URL(sender?.url); } catch { throw new Error("Invalid capture host."); }
    if (!["http://127.0.0.1:11122", "http://localhost:11122"].includes(url.origin)
      || url.pathname !== "/split-capture-host" || !Number.isInteger(sender?.tab?.id)
      || !/^[a-f0-9]{64}$/.test(message.key ?? "") || url.hash !== `#${message.key}`) {
      throw new Error("Invalid capture host capability.");
    }
    if (connecting) {
      report({ phase: "connect_pending" });
      return connecting;
    }
    if (config?.key === message.key && config.tabId === sender.tab.id) {
      report({ phase: "connect_reused", polling });
      void poll(); return { ok: true };
    }
    const startedAt = performance.now();
    report({ phase: "connect_start" });
    connecting = (async () => {
      const response = await request(`${url.origin}/api/bridge/split-capture/bootstrap`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Aku-Capture-Instance": message.key },
        body: JSON.stringify({ sourceWindowLifetime: 1, captureHostClose: 1,
          ...(captureHostOnlyRetirement === true ? { captureHostOnlyRetirement: 1 } : {}) }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Capture host bootstrap rejected.");
      const value = await response.json();
      if (typeof value.token !== "string" || value.token.length < 32 || typeof value.instanceEpoch !== "string") throw new Error("Invalid capture bootstrap response.");
      clearHeartbeat();
      activePoll?.abort();
      config = {
        endpoint: url.origin, key: message.key, token: value.token,
        instanceEpoch: value.instanceEpoch, tabId: sender.tab.id,
        captureHostClose: value.captureHostClose === true,
        captureHostOnlyRetirement: captureHostOnlyRetirement === true && value.captureHostOnlyRetirement === true,
      };
      try {
        await chrome.storage.session.set({ [SESSION_KEY]: config });
        await handlers.configure_background({}, config);
      } catch (error) {
        await stop(config);
        throw error;
      }
      if (config) startHeartbeat(config);
      void poll();
      return { ok: true };
    })();
    try {
      const result = await connecting;
      report({ phase: "connect_ready", elapsedMs: Math.round(performance.now() - startedAt) });
      return result;
    } catch (error) {
      report({ phase: "connect_error", kind: error?.name === "TimeoutError" ? "timeout" : "other", elapsedMs: Math.round(performance.now() - startedAt) });
      throw error;
    } finally { connecting = null; }
  }
  async function restore() {
    const value = (await chrome.storage.session.get(SESSION_KEY))?.[SESSION_KEY];
    if (!value || !Number.isInteger(value.tabId)) return false;
    const tab = await chrome.tabs.get(value.tabId).catch(() => null);
    if (!tab) { await chrome.storage.session.remove(SESSION_KEY); return false; }
    await connect({ key: value.key }, { url: tab.url, tab });
    return true;
  }
  return { connect, restore, headers };
}
