(() => {
  if (globalThis.__akuBrowserTabBridgeInstalled) return;
  globalThis.__akuBrowserTabBridgeInstalled = true;

  const allowedOrigin = "http://127.0.0.1:47821";
  if (window.location.origin !== allowedOrigin) return;

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== allowedOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "AKU_BROWSER_BRIDGE_PING") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_GET_CAPABILITIES",
        });
        if (!response?.capabilities) {
          throw new Error("AkuBridge capability handshake returned no capabilities.");
        }
        window.postMessage(
          {
            type: "AKU_BROWSER_BRIDGE_READY",
            capabilities: response.capabilities,
          },
          allowedOrigin,
        );
      } catch (error) {
        window.postMessage(
          {
            type: "AKU_BROWSER_BRIDGE_ERROR",
            message: String(error?.message ?? error),
          },
          allowedOrigin,
        );
      }
      return;
    }

    if (message.type === "AKU_BROWSER_BRIDGE_RELOAD_SELF") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_RELOAD_SELF",
          actionId: message.actionId,
          endpoint: message.endpoint,
          token: message.token,
        });
        if (!response?.accepted) {
          throw new Error(response?.message || "AkuBridge rejected reload_self.");
        }
      } catch (error) {
        // A disconnected port is expected once chrome.runtime.reload() begins.
        // Sidecar determines success only from the post-reload build heartbeat.
        if (!String(error?.message ?? error).includes("Extension context invalidated")) {
          window.postMessage(
            {
              type: "AKU_BROWSER_BRIDGE_ERROR",
              message: String(error?.message ?? error),
            },
            allowedOrigin,
          );
        }
      }
      return;
    }

    if (message.type !== "AKU_BROWSER_DISPATCH") return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "AKU_BROWSER_DISPATCH",
        endpoint: message.endpoint,
        token: message.token,
        runId: message.runId,
      });
      if (!response?.ok) {
        throw new Error(response?.message || "AkuBridge rejected the dispatch.");
      }
    } catch (error) {
      window.postMessage(
        {
          type: "AKU_BROWSER_BRIDGE_ERROR",
          message: String(error?.message ?? error),
        },
        allowedOrigin,
      );
    }
  });
})();
