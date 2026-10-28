import { sourceDefinition, sourceIds } from "./source-catalog.js";
import { captureWindowPolicyDescriptor } from "./capture-window-runtime.js";

export const CAPTURE_SURFACE_POLICY_SCHEMA = "aku.surface-policy.v1";

// Describe imported executable policy, not files fetched from disk. A browser
// restart can retain an older registered service-worker module graph.
export function captureSurfacePolicyDescriptor({
  definitionFor = sourceDefinition,
  ids = sourceIds(),
  windowPolicy = captureWindowPolicyDescriptor(),
} = {}) {
  return {
    schema: CAPTURE_SURFACE_POLICY_SCHEMA,
    lifecycleRevision: windowPolicy.revision,
    cleanupSchema: windowPolicy.cleanupSchema,
    sources: ids.map((id) => {
      const definition = definitionFor(id);
      return {
        id,
        hostnames: [...definition.hostnames],
        canonical: definition.canonicalFeedPath.source,
        managedRedirect: definition.managedFeedRedirectPath?.source ?? null,
      };
    }),
  };
}

export async function captureSurfacePolicyIdentity(options) {
  const descriptor = captureSurfacePolicyDescriptor(options);
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(descriptor)));
  return {
    schema: CAPTURE_SURFACE_POLICY_SCHEMA,
    fingerprint: [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0")).join(""),
  };
}
