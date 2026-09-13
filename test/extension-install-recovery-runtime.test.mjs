import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as policy from "../extension-install-recovery-policy.js";

const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const recoveryCode = worker.slice(
  worker.indexOf("async function recoverPendingInstalledAkuBrowserTabs()"),
  worker.indexOf("async function expireInstalledAkuBrowserTabRecovery()"),
);

function fixture({ execute, getTab, tabs } = {}) {
  const tab = { id: 1, url: "http://127.0.0.1:11122/", status: "complete" };
  const key = policy.AKU_BROWSER_INSTALL_RECOVERY_STORAGE_KEY;
  const storage = { [key]: policy.createInstalledAkuBrowserTabRecovery({ reason: "install", version: "0.9.0" }) };
  const executions = [];
  const context = vm.createContext({
    ...policy,
    URL,
    console: { warn() {} },
    BRIDGE_DEPLOYMENT: { mode: "production-app" },
    retryInstalledAkuBrowserTabRecovery: (recover, options) => policy.retryInstalledAkuBrowserTabRecovery(recover, {
      ...options, wait: async () => {},
    }),
    clearInstalledAkuBrowserTabRecovery: async () => { delete storage[key]; },
    chrome: {
      storage: { local: {
        get: async () => storage,
        set: async (value) => Object.assign(storage, value),
      } },
      tabs: { query: async () => tabs ?? [tab], get: async (id) => {
        const current = tabs?.find((item) => item.id === id) ?? tab;
        return getTab ? getTab(current) : current;
      } },
      scripting: { executeScript: async (options) => {
        executions.push(options);
        return execute ? execute(options, executions.length) : [{ result: true }];
      } },
    },
  });
  vm.runInContext(recoveryCode, context);
  return { run: () => context.recoverPendingInstalledAkuBrowserTabs(), storage, key, executions };
}

test("worker retries a failed relay injection and pings on the same recovery event", async () => {
  const setup = fixture({ execute: async (options, count) => {
    if (count === 1) throw new Error("frame removed");
    return [{ result: true }];
  } });
  await setup.run();
  assert.equal(setup.executions.length, 3);
  assert.equal(setup.executions[0].files[0], policy.AKU_BROWSER_TAB_BRIDGE_FILE);
  assert.equal(setup.executions[1].files[0], policy.AKU_BROWSER_TAB_BRIDGE_FILE);
  assert.equal(setup.executions[2].args[0], "http://127.0.0.1:11122");
  await setup.run();
  assert.equal(setup.executions.length, 3, "completed event remains idempotent");
});

test("worker revalidates the origin before retrying injection", async () => {
  let foreign = false;
  const setup = fixture({
    execute: async () => { foreign = true; throw new Error("navigated"); },
    getTab: (tab) => foreign ? { ...tab, url: "https://example.org/" } : tab,
  });
  await setup.run();
  assert.equal(setup.executions.length, 1);
});

test("worker bounds persistent failure across repeated tab events", async () => {
  const setup = fixture({ execute: async () => { throw new Error("unavailable"); } });
  await setup.run();
  await setup.run();
  await setup.run();
  assert.equal(setup.executions.length, 6);
});

test("worker retries on a later complete event after the first event exhausts its attempts", async () => {
  let available = false;
  const setup = fixture({ execute: async () => {
    if (!available) throw new Error("frame unavailable");
    return [{ result: true }];
  } });
  await setup.run();
  assert.equal(setup.executions.length, 3);
  assert.equal(setup.storage[setup.key].attemptedTabIds.length, 0);
  available = true;
  await setup.run();
  assert.equal(setup.executions.length, 5);
  assert.equal(setup.storage[setup.key].attemptedTabIds[0], 1);
  await setup.run();
  assert.equal(setup.executions.length, 5);
});

test("failed tabs retain the four-tab budget while later complete events can recover them", async () => {
  let available = false;
  const tabs = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, url: "http://127.0.0.1:11122/", status: "complete",
  }));
  const setup = fixture({ tabs, execute: async () => {
    if (!available) throw new Error("frame unavailable");
    return [{ result: true }];
  } });
  await setup.run();
  assert.equal(setup.executions.length, 12);
  tabs[4].active = true;
  available = true;
  await setup.run();
  assert.equal(setup.executions.length, 20);
  assert.equal(setup.executions.some((options) => options.target.tabId === 5), false);
  assert.equal(setup.storage[setup.key].attemptedTabIds.length, 4);
});
