import { sourceIds } from "./source-catalog.js";
import { captureSurfacePolicyIdentity } from "./capture-surface-policy.js";
import { focusPolicyEvidence } from "./capture-surface-telemetry.js";

// Reporting has no resource authority. Read headers at request time so the
// current split-capture instance remains the request owner.
export function createCaptureSurfaceReporter({ bridgeHeaders, responseError }) {
  async function postCaptureSurfaceEvents(
    endpoint,
    token,
    sessionId,
    runId,
    fallbackSource,
    events,
  ) {
    if (
      typeof endpoint !== "string" ||
      typeof token !== "string" ||
      typeof sessionId !== "string" ||
      !sessionId ||
      !Array.isArray(events) ||
      events.length === 0
    ) return;
    const executingPolicy = await captureSurfacePolicyIdentity();
    const payload = events.flatMap((event) => {
      const source = sourceIds().includes(event?.source)
        ? event.source
        : sourceIds().includes(fallbackSource)
          ? fallbackSource
          : null;
      if (typeof event?.event !== "string") return [];
      return [{
        id: createCaptureSurfaceEventId(),
        sessionId,
        runId: typeof runId === "string" ? runId : "",
        source,
        event: event.event,
        outcome: String(event.outcome ?? event.detail?.outcome ?? "").slice(0, 120),
        detail: {
          ...(event.detail && typeof event.detail === "object" ? event.detail : {}),
          captureSurfacePolicy: executingPolicy,
        },
        occurredAt: typeof event.occurredAt === "string"
          ? event.occurredAt
          : new Date().toISOString(),
      }];
    });
    if (payload.length === 0) return;
    const response = await fetch(`${endpoint}/api/bridge/capture-surfaces/events`, {
      method: "POST",
      headers: {
        ...bridgeHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: payload }),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "Could not record capture-surface telemetry"));
    }
  }

  function captureSurfaceEvent(event, source, detail = {}) {
    return {
      event,
      source: sourceIds().includes(source) ? source : null,
      outcome: String(detail.outcome ?? "").slice(0, 120),
      detail: { ...focusPolicyEvidence(), ...detail },
      occurredAt: new Date().toISOString(),
    };
  }

  function createCaptureSurfaceEventId() {
    if (typeof crypto?.randomUUID === "function") {
      return `capture_surface_${crypto.randomUUID()}`;
    }
    return `capture_surface_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  return { postCaptureSurfaceEvents, captureSurfaceEvent };
}
