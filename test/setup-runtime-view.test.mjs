import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_SETUP_ACTIONS,
  runtimeCheckTimeoutMs,
  runtimeSetupView,
} from "../setup-runtime-view.js";

test("runtime checking starts at 30 seconds and adds 10 seconds per retry", () => {
  assert.equal(runtimeCheckTimeoutMs(), 30_000);
  assert.equal(runtimeCheckTimeoutMs(1), 40_000);
  assert.equal(runtimeCheckTimeoutMs(2), 50_000);
});

test("fresh setup waits for an explicit runtime check", () => {
  const state = runtimeSetupView({ state: "runtime_unchecked" });

  assert.equal(state.badge, "Not checked");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.CHECK);
  assert.equal(state.actionLabel, "Check runtime");
  assert.equal(state.actionDisabled, false);
  assert.equal(state.runtimeReady, false);
});

test("missing Windows runtime offers installation", () => {
  const state = runtimeSetupView(
    { state: "runtime_install_required" },
    { windowsInstallerAvailable: true },
  );

  assert.equal(state.badge, "Not installed");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.INSTALL);
  assert.equal(state.actionLabel, "Install runtime");
  assert.equal(state.actionDisabled, false);
  assert.equal(state.runtimeReady, false);
});

test("outdated runtime offers the bounded native update", () => {
  const state = runtimeSetupView({
    state: "runtime_incompatible",
    response: {
      runtime: { processState: "stopped" },
      update: { currentVersion: "0.7.6", targetVersion: "0.7.7" },
    },
  }, { windowsInstallerAvailable: true });

  assert.equal(state.badge, "Update available");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.ENSURE);
  assert.equal(state.actionLabel, "Update runtime");
  assert.equal(state.retryAction, false);
  assert.match(state.detail, /Version 0\.7\.6 is installed; version 0\.7\.7 is required/);
  assert.equal(state.runtimeReady, false);
});

test("installed stopped runtime offers one run action", () => {
  const state = runtimeSetupView({
    state: "runtime_failed",
    errorCode: "runtime_start_failed",
    response: {
      runtime: { processState: "stopped" },
      update: { currentVersion: "0.7.7", targetVersion: "0.7.7" },
    },
  });

  assert.equal(state.badge, "Ready");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.ENSURE);
  assert.equal(state.actionLabel, "Run AkuBrowser");
  assert.equal(state.retryAction, false);
  assert.equal(state.runtimeReady, false);
});

test("running runtime offers the bounded stop action", () => {
  const state = runtimeSetupView({
    state: "runtime_ready",
    response: { runtime: { processState: "ready", version: "0.7.7" } },
  }, { windowsInstallerAvailable: true });

  assert.equal(state.badge, "Running");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.STOP);
  assert.equal(state.actionLabel, "Stop runtime");
  assert.equal(state.actionDisabled, false);
  assert.equal(state.runtimeReady, true);
  assert.equal(state.showSecurityNotice, false);
  assert.equal(
    state.executableLocation,
    "%LOCALAPPDATA%\\Programs\\AkuBrowser\\runtime\\versions\\0.7.7\\AkuSidecar.exe",
  );
});

test("portable running runtime identifies its extracted executable without guessing a folder", () => {
  const state = runtimeSetupView({
    state: "runtime_ready",
    runtimeSource: "portable",
  }, { windowsInstallerAvailable: true });

  assert.equal(state.executableLocation, "<extracted AkuBrowser folder>\\AkuSidecar.exe");
  assert.equal(
    state.executableLocationHint,
    "Open the folder where you extracted the portable AkuBrowser bundle.",
  );
});

test("stopped runtime returns to the run action", () => {
  const state = runtimeSetupView({ state: "runtime_stopped" });

  assert.equal(state.badge, "Ready");
  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.ENSURE);
  assert.equal(state.actionLabel, "Run AkuBrowser");
  assert.equal(state.runtimeReady, false);
});

test("installer retry exposes the manual fallback", () => {
  const state = runtimeSetupView(
    { state: "runtime_install_required" },
    { windowsInstallerAvailable: true, runtimeInstallerAttempted: true },
  );

  assert.equal(state.showManualFallback, true);
});

test("invalid installed metadata offers installer repair", () => {
  const state = runtimeSetupView({
    state: "runtime_failed",
    remediation: "reinstall_runtime",
  }, { windowsInstallerAvailable: true });

  assert.equal(state.actionKind, RUNTIME_SETUP_ACTIONS.INSTALL);
  assert.equal(state.actionLabel, "Repair runtime");
  assert.equal(state.showInstallerNote, true);
});

test("retryable failure increments the next request timeout", () => {
  const state = runtimeSetupView({ state: "runtime_failed" });

  assert.equal(state.actionLabel, "Try again");
  assert.equal(state.retryAction, true);
});
