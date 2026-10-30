import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceDefinition } from "../source-catalog.js";
import {
  captureSurfacePolicyDescriptor,
  captureSurfacePolicyIdentity,
} from "../capture-surface-policy.js";

test("executing policy identity includes imported feed and lifecycle rules", async () => {
  const descriptor = captureSurfacePolicyDescriptor();
  assert.equal(descriptor.lifecycleRevision, "surface-lifecycle-pending-diagnostics-v2");
  assert.equal(descriptor.cleanupSchema, "aku.surface-cleanup.v1");
  assert.equal(descriptor.sources.find((value) => value.id === "linkedin").managedRedirect,
    "^\\/feed\\/foryou\\/?$");
  const current = await captureSurfacePolicyIdentity();
  assert.match(current.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await captureSurfacePolicyIdentity(), current);
});

test("stale cached catalog changes the identity even with a current build label", async () => {
  const stale = await captureSurfacePolicyIdentity({
    definitionFor(id) {
      const definition = sourceDefinition(id);
      return id === "linkedin"
        ? { ...definition, managedFeedRedirectPath: undefined } : definition;
    },
  });
  assert.notDeepEqual(stale, await captureSurfacePolicyIdentity());
  assert.notDeepEqual(await captureSurfacePolicyIdentity({
    windowPolicy: { revision: "old-lifecycle", cleanupSchema: "aku.surface-cleanup.v1" },
  }), await captureSurfacePolicyIdentity());
});

test("Sidecar pins the executing policy fingerprint and fresh reload handshake", async () => {
  const { fingerprint } = await captureSurfacePolicyIdentity();
  const contract = await readFile(new URL(
    "../../AkuSidecar/internal/engine/bridge_surface_policy.go", import.meta.url), "utf8");
  assert.ok(contract.includes(`ExpectedBridgeSurfacePolicyFingerprint = "${fingerprint}"`));
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.ok(worker.includes("captureSurfacePolicy: await captureSurfacePolicyIdentity()"));
});

test("separately packaged consumers keep one cleanup receipt contract", async () => {
  const bridge = await readFile(new URL("../surface-cleanup-receipt.js", import.meta.url), "utf8");
  const sidecar = await readFile(new URL(
    "../../AkuSidecar/internal/httpapi/web/capture-surface-cleanup-receipt.js", import.meta.url), "utf8");
  assert.equal(bridge.replaceAll("\r\n", "\n"), sidecar.replaceAll("\r\n", "\n"));
});
