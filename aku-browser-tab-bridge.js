(() => {
  if (globalThis.__akuBrowserTabBridgeInstalled) return;
  globalThis.__akuBrowserTabBridgeInstalled = true;

  const allowedOrigins = new Set([
    "http://127.0.0.1:11122",
    "http://localhost:11122",
  ]);
  const allowedOrigin = window.location.origin;
  if (!allowedOrigins.has(allowedOrigin)) return;

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

    if (message.type === "AKU_BROWSER_RELEASE_CAPTURE_SURFACE") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_RELEASE_CAPTURE_SURFACE",
          leaseId: message.leaseId,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge rejected capture-surface release.");
        }
        window.postMessage(
          {
            type: "AKU_BROWSER_CAPTURE_SURFACE_RELEASED",
            leaseId: message.leaseId,
            outcome: response.outcome ?? null,
          },
          allowedOrigin,
        );
      } catch (error) {
        window.postMessage(
          {
            type: "AKU_BROWSER_CAPTURE_SURFACE_RELEASE_FAILED",
            leaseId: message.leaseId,
            message: String(error?.message ?? error),
          },
          allowedOrigin,
        );
      }
      return;
    }

    if (message.type === "AKU_BROWSER_MEDIA_RECAPTURE") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_MEDIA_RECAPTURE",
          endpoint: message.endpoint,
          token: message.token,
          recaptureId: message.recaptureId,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge rejected media recapture.");
        }
        window.postMessage({
          type: "AKU_BROWSER_MEDIA_RECAPTURE_COMPLETED",
          recaptureId: message.recaptureId,
          recapture: response.recapture ?? null,
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_MEDIA_RECAPTURE_FAILED",
          recaptureId: message.recaptureId,
          message: String(error?.message ?? error),
        }, allowedOrigin);
      }
      return;
    }

    if (message.type === "AKU_BROWSER_X_MEDIA_EVIDENCE_LOOKUP") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BROWSER_X_MEDIA_EVIDENCE_LOOKUP",
          candidateIds: message.candidateIds,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge rejected X media evidence lookup.");
        }
        window.postMessage({
          type: "AKU_BROWSER_X_MEDIA_EVIDENCE_RESULT",
          requestId: message.requestId,
          evidence: response.evidence ?? null,
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_X_MEDIA_EVIDENCE_FAILED",
          requestId: message.requestId,
          message: String(error?.message ?? error),
        }, allowedOrigin);
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
          type: "AKU_BROWSER_DISPATCH_FAILED",
          runId: message.runId,
          message: String(error?.message ?? error),
        },
        allowedOrigin,
      );
    }
  });
})();
