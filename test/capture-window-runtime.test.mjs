import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_SURFACE_LEDGER_STORAGE_KEY,
  CAPTURE_WINDOW_STORAGE_KEY,
  createManagedCaptureWindowRuntime,
  normalizeManagedCaptureState,
} from "../capture-window-runtime.js";
import { focusPolicyEvidence } from "../capture-surface-telemetry.js";
let backgroundFocusViolations = 0;
test.afterEach(() => {
  const violations = backgroundFocusViolations;
  backgroundFocusViolations = 0;
  assert.equal(violations, 0, "background capture attempted affirmative foregrounding");
});

// Every fixture rejects foreground writes unless its explicit-action test
// opens this gate. This applies to all routine capture/release tests below.
function backgroundOutcome(overrides = {}) {
  return { changed: false, restored: false, preserved: true, contained: false,
    focusContext: "chrome", ...focusPolicyEvidence(), ...overrides };
}

test("managed capture creates a non-focused window and preserves the working tab", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });

  assert.equal(prepared.opened, true);
  assert.equal(prepared.tab.url, "https://x.com/home");
  assert.equal(chrome.createdWindowOptions.focused, false);
  assert.deepEqual(await prepared.verifyFocus(), backgroundOutcome());
  assert.equal(chrome.focusedWindowId, 1);
  assert.equal(chrome.activeByWindow.get(1), 11);
});

test("managed capture does not override a user's later tab choice", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });
  chrome.addTab(1, "https://example.com/new-work", 12);
  chrome.activeByWindow.set(1, 12);

  assert.deepEqual(await prepared.verifyFocus(), backgroundOutcome());
  assert.equal(chrome.activeByWindow.get(1), 12);
});

test("managed capture contains its activated window without restoring the app UI", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "session-1",
  });
  chrome.focusedWindowId = 2;

  assert.deepEqual(await prepared.requireFocus("target_loaded"), backgroundOutcome({
    changed: true, contained: true, containmentApplied: true, focusContext: "external",
  }));
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.deepEqual(chrome.windowUpdates, [{ id: 2, state: "minimized" }]);
  assert.equal(prepared.lifecycleEvents.some((event) => event.detail.containmentApplied), true);
});

test("managed capture never restores a last-focused Chrome window when another app was initially focused", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("x");
  chrome.focusedWindowId = first.tab.windowId;
  chrome.chromeFocused = false;
  const prepared = await runtime.prepare("x");

  assert.equal(prepared.focusSnapshot.kind, "external");
  assert.deepEqual(await prepared.verifyFocus(), backgroundOutcome({ contained: true, focusContext: "external" }));
  assert.deepEqual(chrome.windowUpdates, [{ id: first.tab.windowId, state: "minimized" }]);
  assert.equal(chrome.chromeFocused, false);
  assert.equal(prepared.lifecycleEvents.some((event) => event.event === "focus_intervention" && event.detail.contained === true), true);
});

test("external focus contains create-time activation and sequential source recreation", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  chrome.focusOnCreate = true;
  for (const source of ["x", "linkedin"]) {
    chrome.chromeFocused = false;
    const prepared = await runtime.prepare(source, { leaseId: "external-session" });
    assert.equal(chrome.createdWindowOptions.state, "minimized");
    assert.equal(chrome.createdWindowOptions.width, undefined);
    assert.equal(chrome.chromeFocused, false);
    assert.equal((await chrome.windows.get(prepared.tab.windowId)).state, "minimized");
    assert.equal(prepared.lifecycleEvents.some((event) => event.event === "focus_intervention" && event.detail.contained === true && event.detail.changed === true), true);
    assert.equal(prepared.lifecycleEvents.filter((event) => event.event === "focus_intervention").length, 1);
    await runtime.releaseSource(source, "external-session");
  }
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
});

test("preemptively minimized capture does not report an intervention on unchanged checks", async () => {
  const chrome = fakeChrome();
  chrome.chromeFocused = false;
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  const created = prepared.lifecycleEvents.find((event) => event.event === "created");
  assert.equal(created.detail.focusContext, "external");
  assert.equal(created.detail.focusContained, true);
  assert.equal(created.detail.focusIntervention, false);
  await prepared.verifyFocus();
  await prepared.requireFocus("target_loaded");
  assert.equal(prepared.lifecycleEvents.some((event) => event.event === "focus_intervention"), false);
  assert.deepEqual(chrome.windowUpdates, []);
});

test("external focus contains reused source and recapture tab activation", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x");
  chrome.chromeFocused = false;
  chrome.focusManagedWindowOnTabActivation = true;
  const prepared = await runtime.prepare("linkedin");
  assert.equal(chrome.chromeFocused, false);
  await prepared.openTargetTab("https://www.linkedin.com/feed/update/urn:li:activity:123456789/");
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
});

test("external focus fails closed if Chrome ignores containment", async () => {
  const chrome = fakeChrome();
  chrome.chromeFocused = false;
  chrome.focusOnCreate = true;
  chrome.failMinimize = true;
  await assert.rejects(createManagedCaptureWindowRuntime(chrome).prepare("x"), (error) => error.details.focusOutcome.preserved === false);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
  assert.deepEqual(chrome.removedWindowIds, [2]);
  assert.equal((await chrome.storage.local.get(CAPTURE_WINDOW_STORAGE_KEY))[CAPTURE_WINDOW_STORAGE_KEY], undefined);
});

test("failed new-tab containment removes only the new source tab and preserves existing tabs", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("x");
  chrome.chromeFocused = false;
  chrome.focusManagedWindowOnTabActivation = true;
  chrome.afterTabUpdate = () => {
    chrome.failMinimize = true;
    chrome.addTab(first.tab.windowId, "https://example.com/user", 999);
  };
  await assert.rejects(runtime.prepare("linkedin"), (error) => error.details.focusOutcome.preserved === false);
  assert.deepEqual(chrome.removedWindowIds, []);
  assert.equal(chrome.removedTabIds.length, 1);
  assert.notEqual(chrome.removedTabIds[0], first.tab.id);
  assert.equal((await chrome.tabs.get(first.tab.id)).url, "https://x.com/home");
  assert.equal((await chrome.tabs.get(999)).url, "https://example.com/user");
  const state = (await chrome.storage.local.get(CAPTURE_WINDOW_STORAGE_KEY))[CAPTURE_WINDOW_STORAGE_KEY];
  assert.equal(state.tabs.x, first.tab.id);
  assert.equal(state.tabs.linkedin, undefined);
});

test("unknown focus is explicit and containment cannot claim a known focus outcome", async () => {
  const chrome = fakeChrome();
  chrome.windows.getLastFocused = async () => { throw new Error("unavailable"); };
  await assert.rejects(createManagedCaptureWindowRuntime(chrome).prepare("x"), (error) => error.details.focusOutcome.focusContext === "unknown" && error.details.focusOutcome.preserved === false);
  assert.equal(chrome.createdWindowOptions.state, "minimized");
});

test("external focus still permits explicit foreground recapture then contains on exit", async () => {
  const chrome = fakeChrome();
  chrome.chromeFocused = false;
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.allowFocusedWrites = true;
  await prepared.showForeground({ userAuthorized: true });
  chrome.allowFocusedWrites = false;
  assert.equal(chrome.chromeFocused, true);
  assert.equal((await chrome.windows.get(prepared.tab.windowId)).state, "normal");
  const outcome = await prepared.verifyFocus();
  assert.equal(outcome.contained, true);
  assert.equal(outcome.restored, false);
  assert.equal(chrome.chromeFocused, false);
});

test("managed capture respects switching to another app during capture", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.focusedWindowId = prepared.tab.windowId;
  chrome.chromeFocused = false;

  assert.equal((await prepared.requireFocus("target_loaded")).contained, true);
  assert.equal((await prepared.verifyFocus()).contained, true);
  assert.deepEqual(chrome.windowUpdates, [{ id: prepared.tab.windowId, state: "minimized" }]);
  assert.equal(prepared.focusSnapshot.kind, "external");
  assert.equal(chrome.chromeFocused, false);
});

test("observed app switch permanently revokes restoration before a later managed steal", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.chromeFocused = false;
  await prepared.verifyFocus();
  chrome.focusManagedWindowOnTabActivation = true;
  await prepared.openTargetTab("https://x.com/example/status/123");
  assert.equal(prepared.focusSnapshot.kind, "external");
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
  assert.equal(prepared.lifecycleEvents.filter((event) => event.detail.phase === "focus_authority_revoked").length, 1);
  assert.equal(prepared.lifecycleEvents.find((event) => event.detail.phase === "focus_authority_revoked").detail.reason, "user_app_switch");
});

test("bounded verification contains delayed target activation after an observed app switch", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.chromeFocused = false;
  await prepared.verifyFocus();
  chrome.afterTabUpdate = () => {
    setTimeout(() => {
      chrome.focusedWindowId = prepared.tab.windowId;
      chrome.chromeFocused = true;
    }, 20);
  };
  await prepared.openTargetTab("https://x.com/example/status/123");
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
  assert.equal(prepared.lifecycleEvents.some((event) => event.detail.phase === "delayed_focus_verification" && event.detail.contained === true), true);
});

test("bounded verification contains delayed managed activation without restoration", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.afterTabUpdate = () => {
    chrome.afterTabUpdate = null;
    setTimeout(() => { chrome.focusedWindowId = prepared.tab.windowId; }, 70);
  };
  await prepared.openTargetTab("https://x.com/example/status/123");
  assert.equal(chrome.chromeFocused, false);
  assert.equal(prepared.lifecycleEvents.some((event) => event.detail.phase === "delayed_focus_verification" && event.detail.contained === true), true);
});

test("unobserved external-to-managed switch cannot restore the previous app window", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.chromeFocused = false; // User switched between observations.
  chrome.focusedWindowId = prepared.tab.windowId;
  chrome.chromeFocused = true; // Capture then activated before the next read.
  chrome.afterTabUpdate = () => { assert.fail("Previous working tab must never be reactivated"); };

  assert.equal((await prepared.verifyFocus()).contained, true);
  assert.deepEqual(chrome.windowUpdates, [{ id: prepared.tab.windowId, state: "minimized" }]);
  assert.equal(chrome.windowUpdates.some((update) => update.focused === true), false);
  const intervention = prepared.lifecycleEvents.find((event) => event.detail.containmentApplied);
  assert.equal(intervention.detail.focusPolicyRevision, "quiet-containment-only-v2");
  assert.equal(intervention.detail.focusPolicyMode, "background_containment_only");
  assert.equal(intervention.detail.restorationSuppressed, true);
  assert.equal(intervention.detail.focusedWriteAttempted, false);
});

test("managed capture does not report restored focus when Chrome loses focus before verification", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x");
  chrome.focusedWindowId = prepared.tab.windowId;
  chrome.afterWindowUpdate = () => { chrome.chromeFocused = false; };

  assert.deepEqual(await prepared.verifyFocus(), backgroundOutcome({ changed: true, contained: true, containmentApplied: true }));
  assert.deepEqual(chrome.windowUpdates, [{ id: prepared.tab.windowId, state: "minimized" }]);
});

test("managed capture records containment and retains candidate capture after activation", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  chrome.focusManagedWindowOnTabActivation = true;

  const prepared = await runtime.prepare("linkedin", { leaseId: "session-1" });

  assert.equal(prepared.tab.url, "https://www.linkedin.com/feed/");
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_window_closed",
    closedTabs: 2,
    closedManagedTabs: 2,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
});

test("multi-window Quiet creates one non-focused managed window per source", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const x = await runtime.prepare("x", {
    leaseId: "session-1",
    windowIsolation: "per_source",
  });
  const linkedin = await runtime.prepare("linkedin", {
    leaseId: "session-1",
    windowIsolation: "per_source",
  });

  assert.notEqual(x.tab.windowId, linkedin.tab.windowId);
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal(chrome.createdWindowOptionsList.every((entry) => entry.focused === false), true);
  assert.equal(chrome.createdTabOptions.length, 0);
  assert.equal(chrome.focusedWindowId, 1);
  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_windows_closed",
    closedTabs: 2,
    closedManagedTabs: 2,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
});

test("managed recapture activates its target inside the background window without foregrounding it", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-1",
  });
  chrome.focusManagedWindowOnTabActivation = true;

  const target = await prepared.openTargetTab("https://x.com/aku/status/123");

  assert.equal(target.url, "https://x.com/aku/status/123");
  assert.equal(target.active, true);
  assert.deepEqual(chrome.createdTabOptions.at(-1), {
    windowId: 2,
    url: "https://x.com/aku/status/123",
    active: false,
  });
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.equal(chrome.activeByWindow.get(2), target.id);
});

test("explicit foreground grant permits one focus write then background containment resumes", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-foreground-1",
  });
  const target = await prepared.openTargetTab("https://x.com/aku/status/123");

  await assert.rejects(prepared.showForeground(), /fresh explicit user action/);
  chrome.allowFocusedWrites = true;
  await prepared.showForeground({ userAuthorized: true });
  chrome.allowFocusedWrites = false;
  await assert.rejects(prepared.showForeground({ userAuthorized: true }), /fresh explicit user action/);

  assert.equal(chrome.focusedWindowId, 2);
  assert.equal(chrome.activeByWindow.get(2), target.id);
  assert.deepEqual(await prepared.verifyFocus(), backgroundOutcome({ changed: true, contained: true, containmentApplied: true }));
  assert.equal(chrome.chromeFocused, false);
  assert.equal(chrome.activeByWindow.get(1), 11);
  assert.deepEqual(chrome.windowUpdates.filter((update) => update.focused), [{ id: 2, state: "normal", focused: true }]);
  const foreground = prepared.lifecycleEvents.filter((event) => event.detail.focusedWriteAttempted);
  assert.equal(foreground.length, 1);
  assert.equal(foreground[0].detail.focusPolicyMode, "explicit_user_foreground");
});

test("managed recapture fails closed and removes its target when containment fails", async () => {
  const chrome = fakeChrome();
  const prepared = await createManagedCaptureWindowRuntime(chrome).prepare("x", {
    leaseId: "recapture-1",
  });
  chrome.focusManagedWindowOnTabActivation = true;
  chrome.failMinimize = true;

  await assert.rejects(
    prepared.openTargetTab("https://x.com/aku/status/123"),
    (error) => error.code === "visible_recovery_required" &&
      error.details?.reason === "managed_target_activation_took_focus",
  );
  assert.deepEqual(chrome.removedTabIds, [22]);
});

test("managed capture refuses creation when missing-tab policy forbids it", async () => {
  const chrome = fakeChrome();
  await assert.rejects(
    createManagedCaptureWindowRuntime(chrome).prepare("linkedin", { openIfMissing: false }),
    (error) => error.code === "visible_recovery_required" &&
      error.stage === "capture_visibility",
  );
});

test("managed capture state accepts only known numeric bindings", () => {
  assert.deepEqual(normalizeManagedCaptureState({
    windowId: 8,
    tabs: { x: 9, linkedin: "10", other: 11 },
    transientTabs: { linkedin: 12, x: "13" },
    leaseId: "session-1",
  }), {
    windowId: 8,
    tabs: { x: 9 },
    transientTabs: { linkedin: 12 },
    sourceWindows: {},
    ownedByBridge: true,
    leaseId: "session-1",
  });
});

test("session release closes a canonical tab created by Adaptive capture", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  chrome.addTab(1, "https://x.com/home", 31);

  assert.deepEqual(await runtime.trackOpenedTab("x", 31, "session-1"), {
    tracked: true,
    source: "x",
  });
  assert.equal(await runtime.isTrackedTab("x", 31, "session-1"), true);
  assert.equal(await runtime.isTrackedTab("x", 31, "another-session"), false);
  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_transient_tabs_closed",
    closedTabs: 1,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedTabIds, [31]);
  assert.equal(chrome.windowsById.has(1), true);
});

test("release closes a fully Bridge-owned managed window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });

  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_window_closed",
    closedTabs: 1,
    closedManagedTabs: 1,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedWindowIds, [2]);
  assert.equal(chrome.windowsById.has(2), false);
});

test("release preserves user tabs added to a Bridge-owned window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  chrome.addTab(2, "https://example.com/user-work", 31);

  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_tabs_closed_user_window_preserved",
    closedTabs: 1,
    closedManagedTabs: 1,
    closedTransientTabs: 0,
    preservedUserTabs: 1,
  });
  assert.deepEqual(chrome.removedWindowIds, []);
  assert.deepEqual(chrome.removedTabIds, [21]);
  assert.equal(chrome.windowsById.get(2).tabs[0].id, 31);
});

test("source failure closes only its Bridge-owned managed tab", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  const facebook = await runtime.prepare("facebook", { leaseId: "session-1" });

  assert.deepEqual(withoutLifecycleEvents(await runtime.releaseSource("facebook", "session-1")), {
    released: true,
    mode: "owned_source_surface_closed",
    closedTabs: 1,
    remainingManagedTabs: 1,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedTabIds, [facebook.tab.id]);
  assert.equal(chrome.windowsById.has(2), true);
  assert.equal(chrome.windowsById.get(2).tabs.length, 1);

  assert.deepEqual(withoutLifecycleEvents(await runtime.release("session-1")), {
    released: true,
    mode: "owned_window_closed",
    closedTabs: 1,
    closedManagedTabs: 1,
    closedTransientTabs: 0,
    preservedUserTabs: 0,
  });
});

test("source release and next-source prepare are serialized across a shared window handoff", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("instagram", { leaseId: "session-1" });
  let releaseWindowRemoval;
  let signalWindowRemovalStarted;
  const windowRemovalStarted = new Promise((resolve) => {
    signalWindowRemovalStarted = resolve;
  });
  const windowRemovalGate = new Promise((resolve) => {
    releaseWindowRemoval = resolve;
  });
  chrome.beforeWindowRemove = async () => {
    signalWindowRemovalStarted();
    await windowRemovalGate;
  };

  const release = runtime.releaseSource("instagram", "session-1");
  await windowRemovalStarted;
  const prepare = runtime.prepare("linkedin", { leaseId: "session-1" });
  await Promise.resolve();

  assert.equal(chrome.createdWindowOptionsList.length, 1);
  releaseWindowRemoval();
  assert.equal((await release).mode, "owned_source_surface_closed");
  const linkedin = await prepare;
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal(chrome.windowsById.has(linkedin.tab.windowId), true);
  assert.equal(linkedin.tab.url, "https://www.linkedin.com/feed/");
});

test("managed Facebook capture resets an internal redirect instead of leaking a new surface", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("facebook", { leaseId: "session-1" });
  await chrome.tabs.update(first.tab.id, {
    url: "https://www.facebook.com/home.php",
  });

  const reused = await runtime.prepare("facebook", { leaseId: "session-1" });

  assert.equal(reused.opened, false);
  assert.equal(reused.reset, true);
  assert.equal(reused.tab.id, first.tab.id);
  assert.equal(reused.tab.url, "https://www.facebook.com/");
  assert.equal(chrome.createdWindowOptionsList.length, 1);
});

test("native-post adoption detaches the reader window and creates a fresh update window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("x", { leaseId: "session-1" });
  const nativePostUrl = "https://x.com/aku/status/123";
  await chrome.tabs.update(first.tab.id, { url: nativePostUrl });

  const second = await runtime.prepare("x", { leaseId: "session-1" });

  assert.notEqual(second.tab.windowId, first.tab.windowId);
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal((await chrome.tabs.get(first.tab.id)).url, nativePostUrl);
  assert.equal(chrome.windowsById.has(first.tab.windowId), true);
  assert.equal(chrome.removedWindowIds.includes(first.tab.windowId), false);

  await runtime.release("session-1");
  await runtime.reconcile();
  assert.equal(chrome.removedWindowIds.includes(second.tab.windowId), true);
  assert.equal(chrome.removedWindowIds.includes(first.tab.windowId), false);
  assert.equal(chrome.windowsById.has(first.tab.windowId), true);
  assert.equal(second.lifecycleEvents.some((event) =>
    event.event === "preserved_user_owned" &&
    event.outcome === "navigation_adopted_by_user"
  ), true, JSON.stringify(second.lifecycleEvents));
});

test("a native reader tab added beside a managed feed forces a separate update window", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("x", { leaseId: "session-1" });
  const reader = chrome.addTab(first.tab.windowId, "https://x.com/aku/status/456", 31);
  await chrome.tabs.update(reader.id, { active: true });
  chrome.focusedWindowId = first.tab.windowId;

  const second = await runtime.prepare("linkedin", { leaseId: "session-1" });

  assert.notEqual(second.tab.windowId, first.tab.windowId);
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal((await chrome.tabs.get(reader.id)).url, "https://x.com/aku/status/456");
  assert.equal(chrome.activeByWindow.get(first.tab.windowId), reader.id);
  assert.equal(chrome.focusedWindowId, first.tab.windowId);
  assert.equal(chrome.removedWindowIds.includes(first.tab.windowId), false);
});

test("source cleanup closes a Bridge-owned Facebook tab after an internal redirect", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const prepared = await runtime.prepare("facebook", { leaseId: "session-1" });
  await chrome.tabs.update(prepared.tab.id, {
    url: "https://www.facebook.com/home.php",
  });

  assert.deepEqual(withoutLifecycleEvents(await runtime.releaseSource("facebook", "session-1")), {
    released: true,
    mode: "owned_source_surface_closed",
    closedTabs: 1,
    remainingManagedTabs: 0,
    preservedUserTabs: 0,
  });
  assert.deepEqual(chrome.removedWindowIds, [2]);
});

test("source cleanup cannot close a newer leased managed tab", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("facebook", { leaseId: "session-2" });

  assert.deepEqual(await runtime.releaseSource("facebook", "session-1"), {
    released: false,
    reason: "lease_mismatch",
  });
  assert.equal(chrome.windowsById.has(2), true);
  assert.deepEqual(chrome.removedTabIds, []);
});

test("release does not close a newer leased surface", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-2" });

  assert.deepEqual(await runtime.release("session-1"), {
    released: false,
    reason: "lease_mismatch",
  });
  assert.equal(chrome.windowsById.has(2), true);
  assert.deepEqual(chrome.removedWindowIds, []);
});

test("ledger reconciliation closes an orphaned managed surface after runtime state is lost", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  await runtime.prepare("x", { leaseId: "session-1" });
  await chrome.storage.local.remove(CAPTURE_WINDOW_STORAGE_KEY);

  const outcome = await createManagedCaptureWindowRuntime(chrome).reconcile();
  const stored = await chrome.storage.local.get(CAPTURE_SURFACE_LEDGER_STORAGE_KEY);

  assert.equal(outcome.events.some((event) =>
    event.event === "reconciled" &&
    event.source === "x" &&
    event.outcome === "orphan_window_reconciled"
  ), true);
  assert.deepEqual(chrome.removedWindowIds, [2]);
  assert.deepEqual(stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].surfaces, []);
  assert.equal(
    stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].receipts.at(-1).outcome,
    "orphan_window_reconciled",
  );
});

test("ledger reconciliation migrates a legacy Adaptive tab before release", async () => {
  const chrome = fakeChrome();
  chrome.addTab(1, "https://x.com/home", 31);
  await chrome.storage.local.set({
    [CAPTURE_WINDOW_STORAGE_KEY]: {
      transientTabs: { x: 31 },
      leaseId: "session-1",
      ownedByBridge: true,
    },
  });

  const runtime = createManagedCaptureWindowRuntime(chrome);
  const outcome = await runtime.reconcile();
  const stored = await chrome.storage.local.get(CAPTURE_SURFACE_LEDGER_STORAGE_KEY);

  assert.deepEqual(outcome.events, []);
  assert.deepEqual(stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].surfaces, [{
    surfaceId: "transient-tab:31",
    windowId: 1,
    kind: "transient_tab",
    isolation: "shared",
    bindings: { x: 31 },
    leaseId: "session-1",
    createdAt: stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].surfaces[0].createdAt,
    updatedAt: stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].surfaces[0].updatedAt,
  }]);

  await runtime.release("session-1");

  assert.deepEqual(chrome.removedTabIds, [31]);
});

test("a new lease reconciles the prior lease before taking ownership", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  const first = await runtime.prepare("x", { leaseId: "session-1" });
  const second = await runtime.prepare("linkedin", { leaseId: "session-2" });

  assert.deepEqual(chrome.removedWindowIds, [first.tab.windowId]);
  assert.equal(chrome.createdWindowOptionsList.length, 2);
  assert.equal(chrome.windowsById.has(second.tab.windowId), true);
  assert.equal(second.lifecycleEvents.some((event) =>
    event.event === "reconciled" && event.source === "x"
  ), true);
});

test("per-source cleanup closes an Adaptive tab and records its ledger receipt", async () => {
  const chrome = fakeChrome();
  const runtime = createManagedCaptureWindowRuntime(chrome);
  chrome.addTab(1, "https://x.com/home", 31);
  await runtime.trackOpenedTab("x", 31, "session-1");

  const outcome = await runtime.releaseSource("x", "session-1");
  const stored = await chrome.storage.local.get(CAPTURE_SURFACE_LEDGER_STORAGE_KEY);

  assert.equal(outcome.mode, "owned_transient_tab_closed");
  assert.deepEqual(chrome.removedTabIds, [31]);
  assert.deepEqual(stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].surfaces, []);
  assert.equal(
    stored[CAPTURE_SURFACE_LEDGER_STORAGE_KEY].receipts.at(-1).outcome,
    "owned_transient_tab_closed",
  );
});

function withoutLifecycleEvents(value) {
  const result = { ...value };
  delete result.events;
  return result;
}

function fakeChrome() {
  const storage = {};
  const windows = new Map([[1, {
    id: 1,
    tabs: [{ id: 11, windowId: 1, active: true, url: "http://127.0.0.1:11122/" }],
  }]]);
  const tabs = new Map([[11, windows.get(1).tabs[0]]]);
  const activeByWindow = new Map([[1, 11]]);
  const state = {
    focusedWindowId: 1,
    chromeFocused: true,
    windowUpdates: [],
    afterTabUpdate: null,
    afterWindowUpdate: null,
    activeByWindow,
    createdWindowOptions: null,
    createdWindowOptionsList: [],
    windowsById: windows,
    removedWindowIds: [],
    removedTabIds: [],
    createdTabOptions: [],
    focusManagedWindowOnTabActivation: false,
    failFocusRestore: false,
    beforeWindowRemove: null,
    addTab(windowId, url, id) {
      const tab = { id, windowId, active: false, url };
      tabs.set(id, tab);
      windows.get(windowId).tabs.push(tab);
      return tab;
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
      async remove(key) { delete storage[key]; },
    } },
    windows: {
      async getLastFocused() { return { id: state.focusedWindowId, focused: state.chromeFocused }; },
      async get(id, { populate } = {}) {
        const window = windows.get(id);
        if (!window) throw new Error("No window");
        return { ...window, ...(populate ? { tabs: [...window.tabs] } : {}), focused: state.chromeFocused && state.focusedWindowId === id };
      },
      async create(options) {
        if (options.focused !== false) backgroundFocusViolations += 1;
        state.createdWindowOptions = options;
        state.createdWindowOptionsList.push({ ...options });
        const windowId = Math.max(...windows.keys()) + 1;
        const tabId = Math.max(...tabs.keys()) + 10;
        const tab = { id: tabId, windowId, active: true, url: options.url };
        tabs.set(tab.id, tab);
        activeByWindow.set(windowId, tab.id);
        windows.set(windowId, { id: windowId, tabs: [tab], state: options.state ?? "normal" });
        if (state.focusOnCreate) {
          state.focusedWindowId = windowId;
          state.chromeFocused = true;
          windows.get(windowId).state = "normal";
        }
        return { id: windowId, tabs: [tab] };
      },
      async update(id, options) {
        if (options.focused === true && !state.allowFocusedWrites) backgroundFocusViolations += 1;
        state.windowUpdates.push({ id, ...options });
        if (options.state && !state.failMinimize) windows.get(id).state = options.state;
        if (options.state === "minimized" && !state.failMinimize && state.focusedWindowId === id) state.chromeFocused = false;
        if (options.focused && state.failFocusRestore) throw new Error("Focus restore blocked");
        if (options.focused) state.focusedWindowId = id;
        if (options.focused) state.chromeFocused = true;
        if (state.afterWindowUpdate) state.afterWindowUpdate();
        return { id };
      },
      async remove(id) {
        const window = windows.get(id);
        if (!window) throw new Error("No window");
        if (state.beforeWindowRemove) await state.beforeWindowRemove(id);
        state.removedWindowIds.push(id);
        for (const tab of window.tabs) tabs.delete(tab.id);
        windows.delete(id);
        activeByWindow.delete(id);
      },
    },
    tabs: {
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab");
        return { ...tab, active: activeByWindow.get(tab.windowId) === id };
      },
      async query({ active, windowId }) {
        if (!active) return [];
        const id = activeByWindow.get(windowId);
        return id ? [{ ...tabs.get(id), active: true }] : [];
      },
      async update(id, options) {
        const tab = tabs.get(id);
        if (typeof options.url === "string") tab.url = options.url;
        if (options.active) {
          activeByWindow.set(tab.windowId, id);
          if (state.focusManagedWindowOnTabActivation) {
            state.focusedWindowId = tab.windowId;
            state.chromeFocused = true;
            windows.get(tab.windowId).state = "normal";
          }
        }
        if (state.afterTabUpdate) state.afterTabUpdate();
        return {
          ...tab,
          active: activeByWindow.get(tab.windowId) === id,
        };
      },
      async create(options) {
        state.createdTabOptions.push({ ...options });
        const id = Math.max(...tabs.keys()) + 1;
        const tab = state.addTab(options.windowId, options.url, id);
        if (options.active) activeByWindow.set(options.windowId, id);
        return { ...tab, active: options.active === true };
      },
      async remove(ids) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = tabs.get(id);
          if (!tab) continue;
          state.removedTabIds.push(id);
          tabs.delete(id);
          const window = windows.get(tab.windowId);
          window.tabs = window.tabs.filter((candidate) => candidate.id !== id);
        }
      },
    },
  };
  return state;
}
