// Optional Windows split transport. Nothing runs until the explicitly launched
// capture-host page supplies its instance capability or that session is restored.
import { BRIDGE_CONTRACT_VERSION, BRIDGE_ID } from "./bridge-capabilities.js";
const SESSION_KEY = "akuWindowsSplitCaptureSession";
export function createSplitCaptureClient({ chrome, fetch: request = globalThis.fetch, handlers, delay = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let config = null;
  let polling = false;
  let connecting = null;
  const headers = () => config ? { "X-Aku-Capture-Instance": config.key } : {};
  const bridgeHeaders = (c) => ({
    "Content-Type": "application/json", "X-Aku-Capture-Instance": c.key,
    "X-Aku-Bridge-Token": c.token, "X-Aku-Bridge-Contract": BRIDGE_CONTRACT_VERSION,
    "X-Aku-Bridge-Id": BRIDGE_ID,
  });
  async function execute(action, c) {
    let response;
    try {
      const handler = Object.hasOwn(handlers, action.type) ? handlers[action.type] : null;
      if (!handler) throw new Error("Unsupported split capture action.");
      const context = action.type === "open_native_post" ? {
        ...c,
        readerIntent: {
          url: `${c.endpoint}/split-reader-intent?id=${encodeURIComponent(action.id)}`,
          prepare: () => readerRequest("prepare", action, c),
          foreground: () => readerRequest("foreground", action, c),
        },
      } : c;
      response = { ok: true, result: await handler(action, context) ?? {} };
    } catch (error) {
      response = { ok: false, message: String(error?.message ?? error).slice(0, 600) };
    }
    // No result/action is retried across a new capture instance or epoch.
    if (config !== c) return;
    const result = await request(`${c.endpoint}/api/bridge/split-capture/results/${encodeURIComponent(action.id)}`, {
      method: "POST", headers: bridgeHeaders(c), body: JSON.stringify(response), signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok) throw new Error("Capture result was rejected or expired.");
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
  async function poll() {
    if (polling || !config) return;
    polling = true;
    try {
      while (config) {
        const c = config;
        try {
          const response = await request(`${c.endpoint}/api/bridge/split-capture/next`, {
            headers: bridgeHeaders(c), cache: "no-store", signal: AbortSignal.timeout(25_000),
          });
          if ([401, 403, 409, 410].includes(response.status)) {
            config = null; await chrome.storage.session.remove(SESSION_KEY); break;
          }
          if (response.status === 204) continue;
          if (!response.ok) throw new Error("Capture action poll failed.");
          const payload = await response.json();
          if (payload.instanceEpoch !== c.instanceEpoch || typeof payload.action?.id !== "string") {
            config = null; await chrome.storage.session.remove(SESSION_KEY); break;
          }
          // Captures can be long. Keep claiming release/control requests while
          // a bounded capture executes; existing command/lease guards own them.
          void execute(payload.action, c).catch(() => undefined);
        } catch {
          await delay(2000);
        }
      }
    } finally { polling = false; }
  }
  async function connect(message, sender) {
    let url;
    try { url = new URL(sender?.url); } catch { throw new Error("Invalid capture host."); }
    if (!["http://127.0.0.1:11122", "http://localhost:11122"].includes(url.origin)
      || url.pathname !== "/split-capture-host" || !Number.isInteger(sender?.tab?.id)
      || !/^[a-f0-9]{64}$/.test(message.key ?? "") || url.hash !== `#${message.key}`) {
      throw new Error("Invalid capture host capability.");
    }
    if (connecting) return connecting;
    if (config?.key === message.key && config.tabId === sender.tab.id) { void poll(); return { ok: true }; }
    connecting = (async () => {
      const response = await request(`${url.origin}/api/bridge/split-capture/bootstrap`, {
        method: "POST", headers: { "X-Aku-Capture-Instance": message.key }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Capture host bootstrap rejected.");
      const value = await response.json();
      if (typeof value.token !== "string" || value.token.length < 32 || typeof value.instanceEpoch !== "string") throw new Error("Invalid capture bootstrap response.");
      config = { endpoint: url.origin, key: message.key, token: value.token, instanceEpoch: value.instanceEpoch, tabId: sender.tab.id };
      try {
        await chrome.storage.session.set({ [SESSION_KEY]: config });
        await handlers.configure_background({}, config);
      } catch (error) {
        config = null;
        await chrome.storage.session.remove(SESSION_KEY).catch(() => undefined);
        throw error;
      }
      void poll();
      return { ok: true };
    })();
    try { return await connecting; } finally { connecting = null; }
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
