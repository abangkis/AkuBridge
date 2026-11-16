import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DIAGNOSTIC_SCRIPTS } from "../source-access-policy.js";
import { sourceForUrl } from "../source-catalog.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sender = { id: "extension", tab: { id: 42 }, frameId: 0, documentId: "document-A", url: "https://www.instagram.com/" };
function fixture() {
  let now = 0;
  const realm = vm.createContext({});
  for (const file of DIAGNOSTIC_SCRIPTS) vm.runInContext(readFileSync(new URL("../" + file, import.meta.url), "utf8"), realm);
  const options = { extensionId: "extension", sourceForUrl, project: realm.AkuBridgeDiagnostics.project,
    validAttempt: realm.AkuBridgeDiagnostics.validAttempt, now: () => now };
  return { realm, options, cache: realm.AkuChromeDiagnostics.createAttemptCache(options), advance: ms => { now += ms; } };
}
const message = (attemptId, sequence = 1, stage = "capture_started") => ({
  schemaVersion: 1, attemptId, sequence, progress: { stage, source: "instagram", token: "must not escape" },
});

test("cache requires exact attempt, trusted document, top frame, tab and source", () => {
  const f = fixture(), handle = f.cache.begin({ id: id(1), tabId: 42, source: "instagram" });
  assert.equal(handle.state().deliveryComplete, false);
  assert.equal(f.cache.receive(message(id(1)), sender), false, "unbound document is unavailable");
  assert.equal(handle.bind("document-A"), true);
  assert.equal(handle.bind("document-B"), false);
  for (const bad of [
    { ...sender, id: "foreign" }, { ...sender, documentId: "document-B" },
    { ...sender, frameId: 1 }, { ...sender, tab: { id: 43 } },
    { ...sender, url: "https://www.linkedin.com/feed/" },
  ]) assert.equal(f.cache.receive(message(id(1)), bad), false);
  assert.equal(f.cache.receive(message(id(2)), sender), false);
  assert.equal(f.cache.receive({ ...message(id(1)), schemaVersion: 2 }, sender), false);
  assert.equal(f.cache.receive(message(id(1)), sender), true);
  assert.deepEqual(JSON.parse(JSON.stringify(handle.latest())), { stage: "capture_started", source: "instagram" });
  assert.equal(f.cache.receive(message(id(1)), sender), false, "duplicate");
  assert.equal(f.cache.receive(message(id(1), 0), sender), false, "older sequence");
  assert.equal(f.cache.receive(message(id(1), 2, "capture_completed"), sender), true);
  assert.equal(handle.state().deliveryComplete, true);
  assert.equal(f.cache.receive(message(id(1), 3, "extracting_block"), sender), false, "terminal progress cannot reopen");
});

test("gaps, old attempt data, expiry and worker replacement cannot fabricate a complete stream", () => {
  const f = fixture(), handle = f.cache.begin({ id: id(1), tabId: 42, source: "instagram" });
  handle.bind("document-A");
  assert.equal(f.cache.receive(message(id(1), 3, "capture_completed"), sender), true);
  assert.equal(handle.state().deliveryComplete, false);
  assert.equal(handle.state().gap, true);
  const next = f.cache.begin({ id: id(2), tabId: 42, source: "instagram" }); next.bind("document-A");
  assert.equal(next.latest(), null);
  assert.equal(next.pull({ attemptId: id(1), sequence: 4, diagnostics: message(id(1)).progress }), null);
  handle.dispose();
  assert.equal(f.cache.receive(message(id(1), 4), sender), false);
  assert.equal(f.realm.AkuChromeDiagnostics.createAttemptCache(f.options).receive(message(id(2)), sender), false);
  f.advance(120_000);
  assert.equal(f.cache.receive(message(id(2)), sender), false);
  assert.equal(next.latest(), null);
});

test("cache is bounded and releases capacity on disposal or expiry", () => {
  const f = fixture(), handles = [];
  for (let n = 1; n <= 32; n++) handles.push(f.cache.begin({ id: id(n), tabId: 42, source: "instagram" }));
  assert.throws(() => f.cache.begin({ id: id(33), tabId: 42, source: "instagram" }));
  handles[0].dispose();
  f.cache.begin({ id: id(33), tabId: 42, source: "instagram" });
  f.advance(120_000);
  assert.doesNotThrow(() => f.cache.begin({ id: id(34), tabId: 42, source: "instagram" }));
});

test("publisher coalesces a stalled receiver without blocking progress and ignores late settlement", async () => {
  const f = fixture(), calls = []; let settle, drops = 0;
  const publisher = f.realm.AkuChromeDiagnostics.createPublisher({
    attemptId: id(1), validAttempt: f.options.validAttempt, project: f.options.project,
    send: value => { calls.push(value); return new Promise(resolve => { settle = resolve; }); },
    dropped: () => { drops++; },
  });
  for (let n = 1; n <= 1000; n++) publisher.publish(n, message(id(1)).progress);
  assert.equal(calls.length, 1);
  assert.ok(drops > 0);
  assert.equal(JSON.stringify(calls).includes("must not escape"), false);
  publisher.dispose(); settle({ ok: true }); await flush();
  assert.equal(calls.length, 1);
});

test("publisher bounds total messages and contains transport and callback failures", async () => {
  const f = fixture(); let sent = 0;
  const publisher = f.realm.AkuChromeDiagnostics.createPublisher({
    attemptId: id(1), validAttempt: f.options.validAttempt, project: f.options.project,
    send: async () => { sent++; throw Error("receiver unavailable"); },
    dropped: () => { throw Error("observer failed"); },
  });
  for (let n = 1; n <= 100; n++) { publisher.publish(n, message(id(1)).progress); await flush(); }
  assert.equal(sent, 64);
  publisher.dispose();
});
