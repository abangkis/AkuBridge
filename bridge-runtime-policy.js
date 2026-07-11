export class AkuBridgeError extends Error {
  constructor(code, stage, message, details = {}) {
    super(message);
    this.name = "AkuBridgeError";
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

export function createTabLease(tab, source, opened = false) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) {
    throw new AkuBridgeError("invalid_tab", "tab_binding", "AkuBridge could not bind an incomplete source tab reference.");
  }
  return Object.freeze({
    tabId: tab.id,
    windowId: tab.windowId,
    source,
    opened,
    boundUrl: tab.url ?? "",
    boundAt: new Date().toISOString(),
  });
}

export function validateTabLease(lease, tab) {
  if (!tab) return { valid: false, code: "tab_stale", reason: "tab_missing" };
  if (tab.id !== lease.tabId || tab.windowId !== lease.windowId) {
    return { valid: false, code: "tab_replaced", reason: "tab_identity_changed" };
  }
  if (!sourceMatchesUrl(lease.source, tab.url)) {
    return { valid: false, code: "wrong_page", reason: "source_url_changed" };
  }
  return { valid: true, code: null, reason: null };
}

export function createCommandGuard() {
  const active = new Set();
  const terminal = new Set();
  return Object.freeze({
    begin(commandId) {
      if (!commandId || active.has(commandId) || terminal.has(commandId)) return false;
      active.add(commandId);
      return true;
    },
    finish(commandId) {
      active.delete(commandId);
      terminal.add(commandId);
    },
    abandon(commandId) {
      active.delete(commandId);
    },
    isTerminal(commandId) {
      return terminal.has(commandId);
    },
  });
}

export function serializeBridgeError(error, fallbackStage = "capture") {
  return {
    code: error?.code ?? classifyBridgeError(error),
    stage: error?.stage ?? fallbackStage,
    message: String(error?.message ?? error),
    details: error?.details ?? {},
  };
}

export function classifyBridgeError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (/no tab with id|tab was closed|tab.*not found/.test(message)) return "tab_stale";
  if (/does not match|wrong.page|source url changed/.test(message)) return "wrong_page";
  if (/login_required|login required/.test(message)) return "login_required";
  if (/selector_mismatch|selector mismatch/.test(message)) return "selector_mismatch";
  if (/content script|receiving end does not exist/.test(message)) return "content_script_unavailable";
  if (/deadline|timed out|timeout|loading in time/.test(message)) return "deadline_exceeded";
  if (/frontier no longer matched/.test(message)) return "frontier_mismatch";
  if (/no visible|zero evidence|capture_empty/.test(message)) return "capture_empty";
  return "bridge_failure";
}

function sourceMatchesUrl(source, value) {
  try {
    const url = new URL(value);
    if (source === "x") return url.protocol === "https:" && url.hostname === "x.com";
    return source === "linkedin" && url.protocol === "https:" && url.hostname === "www.linkedin.com";
  } catch {
    return false;
  }
}
