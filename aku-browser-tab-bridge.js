(() => {
  const allowedOrigins = new Set([
    "http://127.0.0.1:11122",
    "http://localhost:11122",
  ]);
  const allowedOrigin = window.location.origin;
  if (!allowedOrigins.has(allowedOrigin)) return;
  if (globalThis.__akuBrowserTabBridgeInstalled) return;
  globalThis.__akuBrowserTabBridgeInstalled = true;
  let sidecarProtocolMajor = 0;

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== allowedOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "AKU_BROWSER_BRIDGE_PING") {
      sidecarProtocolMajor = message.protocolMajor === 2 ? 2 : 0;
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
            capabilities: capabilitiesForSidecar(
              response.capabilities,
              sidecarProtocolMajor,
            ),
            extensionOrigin: chrome.runtime.getURL("").replace(/\/$/, ""),
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

    if (message.type === "AKU_BROWSER_PROBE_SOURCE_SESSIONS") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_PROBE_SOURCE_SESSIONS",
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge source session probe failed.");
        }
        window.postMessage({
          type: "AKU_BROWSER_SOURCE_SESSIONS_RESULT",
          sessions: response.sessions ?? {},
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_SOURCE_SESSIONS_FAILED",
          message: String(error?.message ?? error),
        }, allowedOrigin);
      }
      return;
    }

    if (message.type === "AKU_BROWSER_OPEN_SOURCE") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_OPEN_SOURCE",
          source: message.source,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge could not open the source.");
        }
        window.postMessage({
          type: response.state === "permission_required"
            ? "AKU_BROWSER_SOURCE_PERMISSION_REQUIRED"
            : "AKU_BROWSER_SOURCE_OPENED",
          source: response.source,
          url: response.url,
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_SOURCE_OPEN_FAILED",
          source: message.source,
          message: String(error?.message ?? error),
        }, allowedOrigin);
      }
      return;
    }

    if (message.type === "AKU_BROWSER_OPEN_NATIVE_POST") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_OPEN_NATIVE_POST",
          source: message.source,
          url: message.url,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge could not open the native post.");
        }
        window.postMessage({
          type: "AKU_BROWSER_NATIVE_POST_OPENED",
          requestId: message.requestId,
          source: response.source,
          url: response.url,
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_NATIVE_POST_OPEN_FAILED",
          requestId: message.requestId,
          source: message.source,
          message: String(error?.message ?? error),
        }, allowedOrigin);
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
          source: message.source ?? null,
        });
        if (!response?.ok) {
          throw new Error(response?.message || "AkuBridge rejected capture-surface release.");
        }
        window.postMessage(
          {
            type: "AKU_BROWSER_CAPTURE_SURFACE_RELEASED",
            leaseId: message.leaseId,
            source: message.source ?? null,
            outcome: response.outcome ?? null,
          },
          allowedOrigin,
        );
      } catch (error) {
        window.postMessage(
          {
            type: "AKU_BROWSER_CAPTURE_SURFACE_RELEASE_FAILED",
            leaseId: message.leaseId,
            source: message.source ?? null,
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

    if (message.type === "AKU_BROWSER_CONFIGURE_BACKGROUND_DISPATCH") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "AKU_BRIDGE_CONFIGURE_BACKGROUND_DISPATCH",
          endpoint: message.endpoint,
          token: message.token,
          protocolMajor: sidecarProtocolMajor,
        });
        if (!response?.ok) throw new Error(response?.message || "AkuBridge rejected background dispatch configuration.");
      } catch (error) {
        window.postMessage({ type: "AKU_BROWSER_BRIDGE_ERROR", message: String(error?.message ?? error) }, allowedOrigin);
      }
      return;
    }

    if (message.type === "AKU_BROWSER_OPEN_BRIDGE_SETUP") {
      try {
        const response = await chrome.runtime.sendMessage({ type: "AKU_BRIDGE_OPEN_SETUP" });
        if (!response?.ok) throw new Error(response?.message || "AkuBridge setup could not be opened.");
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_BRIDGE_ERROR",
          message: String(error?.message ?? error),
        }, allowedOrigin);
      }
      return;
    }

    if (message.type === "AKU_BROWSER_REVOKE_SOURCE_ACCESS") {
      try {
        const response = await chrome.runtime.sendMessage({ type: "AKU_BRIDGE_REVOKE_SOURCE_ACCESS" });
        if (!response?.ok) throw new Error(response?.message || "AkuBridge rejected source access revocation.");
        window.postMessage({
          type: "AKU_BROWSER_REVOKE_SOURCE_ACCESS_RESULT",
          requestId: message.requestId,
          grantedSources: response.grantedSources ?? [],
        }, allowedOrigin);
      } catch (error) {
        window.postMessage({
          type: "AKU_BROWSER_REVOKE_SOURCE_ACCESS_FAILED",
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

  function capabilitiesForSidecar(capabilities, protocolMajor) {
    if (protocolMajor === 2) return capabilities;
    const {
      protocolMajor: _protocolMajor,
      protocolMinor: _protocolMinor,
      updateCapabilities: _updateCapabilities,
      ...legacyCapabilities
    } = capabilities;
    return legacyCapabilities;
  }
})();
