import test from "node:test";
import assert from "node:assert/strict";
import { openSourceWindow } from "./source-window-runtime.js";

function fixture() {
  const events = [];
  const chrome = {
    windows: { create: async options => { events.push(["create", options.url]); return { id: 7, tabs: [{ id: 8, url: options.url }] }; }, remove: async id => events.push(["remove", id]) },
    tabs: { update: async (id, options) => { events.push(["navigate", id, options.url]); return { id, url: options.url }; } },
  };
  return { chrome, events };
}
test("native lifetime is recorded before source navigation", async () => {
  const { chrome, events } = fixture();
  await openSourceWindow(chrome, "https://facebook.com/", { url: "http://localhost/marker", prepare: async () => events.push(["prepare"]) });
  assert.deepEqual(events, [["create", "http://localhost/marker"], ["prepare"], ["navigate", 8, "https://facebook.com/"]]);
});
test("failed binding closes only the new marker window without source navigation", async () => {
  const { chrome, events } = fixture();
  await assert.rejects(openSourceWindow(chrome, "https://x.com/", { url: "marker", prepare: async () => { throw Error("rejected"); } }), /rejected/);
  assert.deepEqual(events, [["create", "marker"], ["remove", 7]]);
});
test("legacy transport opens source directly", async () => {
  const { chrome, events } = fixture();
  await openSourceWindow(chrome, "https://x.com/");
  assert.deepEqual(events, [["create", "https://x.com/"]]);
});
test("navigation failure preserves the window already recorded by native tracking", async () => {
  const { chrome, events } = fixture();
  chrome.tabs.update = async () => { throw Error("navigation"); };
  await assert.rejects(openSourceWindow(chrome, "https://x.com/", { url: "marker", prepare: async () => {} }), /navigation/);
  assert.deepEqual(events, [["create", "marker"]]);
});
