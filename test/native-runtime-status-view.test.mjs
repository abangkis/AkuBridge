import test from "node:test";
import assert from "node:assert/strict";
import { nativeRuntimeStatusView } from "../native-runtime-status-view.js";

test("popup keeps healthy and degraded-compatible runtime states quiet", () => {
  assert.equal(nativeRuntimeStatusView({ state: "runtime_ready", update: { phase: "idle" } }), null);
  assert.equal(nativeRuntimeStatusView({ state: "runtime_ready", compatibility: "degraded" }), null);
});

test("popup describes staged and idle-deferred updates without blocking use", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_updating",
    update: { phase: "staged" },
  }), {
    tone: "staged",
    title: "Update prepared",
    detail: "AkuSidecar will apply it without interrupting active work.",
  });
  assert.equal(nativeRuntimeStatusView({
    state: "runtime_busy",
    update: { phase: "waiting_for_idle" },
  }).tone, "waiting");
});

test("popup distinguishes automatic retry from mandatory recovery", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_failed",
    retryable: true,
  }), {
    tone: "error",
    title: "AkuSidecar update needs attention",
    detail: "It will retry automatically.",
  });
  assert.equal(nativeRuntimeStatusView({ state: "runtime_incompatible" }).tone, "mandatory");
  assert.equal(nativeRuntimeStatusView({ state: "runtime_install_required" }).tone, "mandatory");
});

test("popup surfaces required security updates while compatible capture remains available", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_ready",
    update: { phase: "waiting_for_idle", urgency: "security" },
  }), {
    tone: "mandatory",
    title: "Security update required",
    detail: "It will be applied when current work is idle.",
  });
});

test("popup requests one updater-host refresh without declaring the current runtime unusable", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_ready",
    hostUpgradeRequired: true,
    update: { phase: "idle" },
  }), {
    tone: "mandatory",
    title: "AkuSidecar updater needs refresh",
    detail: "Open Setup and run this Bridge release's compatible installer. Your current runtime remains usable.",
  });
});

test("legacy host refresh remains the actionable recovery when its update check also fails", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_failed",
    hostUpgradeRequired: true,
    errorCode: "update_check_failed",
    retryable: true,
    update: { phase: "checking" },
  }), {
    tone: "mandatory",
    title: "AkuSidecar updater needs refresh",
    detail: "Open Setup and run this Bridge release's compatible installer to refresh the update helper.",
  });
});

test("non-retryable activation failure outranks mandatory-update urgency", () => {
  assert.deepEqual(nativeRuntimeStatusView({
    state: "runtime_ready",
    errorCode: "candidate_health_failed",
    retryable: false,
    update: { phase: "health_check", urgency: "security" },
  }), {
    tone: "error",
    title: "AkuSidecar update needs attention",
    detail: "Open Setup for recovery options.",
  });
});

test("routine offline discovery remains quiet while scheduler retries", () => {
  assert.equal(nativeRuntimeStatusView({
    state: "runtime_ready",
    errorCode: "update_check_failed",
    silentError: true,
    retryable: true,
    update: { phase: "checking" },
  }), null);
});

test("security policy remains visible when a retryable download fails", () => {
  assert.equal(nativeRuntimeStatusView({
    state: "runtime_ready",
    errorCode: "download_failed",
    silentError: true,
    retryable: true,
    update: { phase: "downloading", urgency: "security" },
  })?.title, "Security update required");
});
