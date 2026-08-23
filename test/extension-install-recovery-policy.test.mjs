import test from "node:test";
import assert from "node:assert/strict";
import {
  AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS,
  AKU_BROWSER_INSTALL_RECOVERY_TTL_MS,
  AKU_BROWSER_TAB_BRIDGE_FILE,
  AKU_BROWSER_LOOPBACK_URL_PATTERNS,
  createInstalledAkuBrowserTabRecovery,
  isCurrentInstalledAkuBrowserTabRecovery,
  isTrustedAkuBrowserTab,
  selectInstalledAkuBrowserTabs,
  shouldRecoverInstalledAkuBrowserTabs,
} from "../extension-install-recovery-policy.js";

test("development and installed-app lanes recover only after install or update", () => {
  for (const mode of ["development", "production-app"]) {
    assert.equal(shouldRecoverInstalledAkuBrowserTabs({ mode, reason: "install" }), true);
    assert.equal(shouldRecoverInstalledAkuBrowserTabs({ mode, reason: "update" }), true);
    assert.equal(shouldRecoverInstalledAkuBrowserTabs({ mode, reason: "chrome_update" }), false);
  }
  assert.equal(shouldRecoverInstalledAkuBrowserTabs({ mode: "production-store", reason: "install" }), false);
  assert.equal(shouldRecoverInstalledAkuBrowserTabs({ mode: "development", reason: "startup" }), false);
});

test("recovery trusts only the two exact AkuBrowser loopback origins", () => {
  assert.deepEqual(AKU_BROWSER_LOOPBACK_URL_PATTERNS, [
    "http://127.0.0.1:11122/*",
    "http://localhost:11122/*",
  ]);
  assert.equal(AKU_BROWSER_TAB_BRIDGE_FILE, "aku-browser-tab-bridge.js");
  assert.equal(isTrustedAkuBrowserTab({ id: 1, url: "http://127.0.0.1:11122/" }), true);
  assert.equal(isTrustedAkuBrowserTab({ id: 2, url: "http://localhost:11122/settings" }), true);
  for (const url of [
    "https://127.0.0.1:11122/",
    "http://127.0.0.1:11123/",
    "http://127.0.0.2:11122/",
    "http://attacker.example/",
    "http://user:pass@127.0.0.1:11122/",
  ]) {
    assert.equal(isTrustedAkuBrowserTab({ id: 3, url }), false, url);
  }
  assert.equal(isTrustedAkuBrowserTab({ id: 4, url: "http://127.0.0.1:11122/", discarded: true }), false);
});

test("candidate selection is idempotent, active-first, and bounded", () => {
  const tabs = Array.from({ length: AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS + 2 }, (_, index) => ({
    id: index + 1,
    url: "http://127.0.0.1:11122/",
    active: index === 2,
    status: "complete",
    lastAccessed: index,
  })).concat({
    id: 99,
    url: "http://127.0.0.1:11122/",
    active: true,
    status: "loading",
    lastAccessed: 99,
  });
  const selected = selectInstalledAkuBrowserTabs(tabs);
  assert.equal(selected.length, AKU_BROWSER_INSTALL_RECOVERY_MAX_TABS);
  assert.equal(selected[0].id, 3);
  assert.equal(selected.some((tab) => tab.id === 99), false);
  assert.deepEqual(
    selectInstalledAkuBrowserTabs(tabs, { attemptedTabIds: selected.map((tab) => tab.id) }),
    [
      {
        id: 2,
        url: "http://127.0.0.1:11122/",
        active: false,
        status: "complete",
        lastAccessed: 1,
      },
      {
        id: 1,
        url: "http://127.0.0.1:11122/",
        active: false,
        status: "complete",
        lastAccessed: 0,
      },
    ],
  );
});

test("recovery state is short-lived and carries a per-event idempotence key", () => {
  const state = createInstalledAkuBrowserTabRecovery({ reason: "install", version: "0.8.0", now: 100 });
  assert.equal(state.eventKey, "install:0.8.0");
  assert.deepEqual(state.attemptedTabIds, []);
  assert.equal(state.expiresAt, 100 + AKU_BROWSER_INSTALL_RECOVERY_TTL_MS);
  assert.equal(isCurrentInstalledAkuBrowserTabRecovery(state, { now: 100 }), true);
  assert.equal(isCurrentInstalledAkuBrowserTabRecovery(state, { now: state.expiresAt }), false);
  assert.equal(
    isCurrentInstalledAkuBrowserTabRecovery({ ...state, eventKey: "update:0.8.0" }, { now: 100 }),
    false,
  );
  assert.equal(
    isCurrentInstalledAkuBrowserTabRecovery({ ...state, expiresAt: state.createdAt }, { now: 100 }),
    false,
  );
  assert.throws(
    () => createInstalledAkuBrowserTabRecovery({ reason: "startup", version: "0.8.0" }),
    /Unsupported AkuBridge install recovery reason/,
  );
});
