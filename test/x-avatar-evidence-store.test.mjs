import assert from "node:assert/strict";
import test from "node:test";

import {
  createXAvatarEvidenceStore,
  sanitizeXAvatarEvidenceUrl,
} from "../x-avatar-evidence-store.js";

function fakeStorage() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, structuredClone(update)); },
  };
}

test("persistent X avatar evidence is strict and stores only status or handle aliases", async () => {
  const storage = fakeStorage();
  const store = createXAvatarEvidenceStore(storage, { now: () => 1_000 });
  const result = await store.put(
    ["x:status:12345", "x:user:Owner_Name", "unbounded arbitrary text"],
    "https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg#fragment",
  );
  assert.deepEqual(result, { accepted: true, acceptedCount: 2 });
  const evidence = await store.lookup(["x:status:12345", "x:user:owner_name"]);
  assert.deepEqual(evidence.entries, [
    { key: "x:status:12345", url: "https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg" },
    { key: "x:user:owner_name", url: "https://pbs.twimg.com/profile_images/12345/avatar_normal.jpg" },
  ]);
  assert.equal(JSON.stringify(storage.values).includes("arbitrary text"), false);
});

test("persistent X avatar evidence expires and retains only the newest bounded entries", async () => {
  let current = 1_000;
  const storage = fakeStorage();
  const store = createXAvatarEvidenceStore(storage, {
    now: () => current,
    ttlMs: 1_000,
    maxEntries: 2,
  });
  await store.put("x:user:first", "https://pbs.twimg.com/profile_images/1/first.jpg");
  await store.put("x:user:second", "https://pbs.twimg.com/profile_images/2/second.jpg");
  await store.put("x:user:third", "https://pbs.twimg.com/profile_images/3/third.jpg");
  let evidence = await store.lookup(["x:user:first", "x:user:second", "x:user:third"]);
  assert.deepEqual(evidence.entries.map((entry) => entry.key), ["x:user:second", "x:user:third"]);
  current = 2_001;
  evidence = await store.lookup(["x:user:second", "x:user:third"]);
  assert.equal(evidence.entries.length, 0);
});

test("persistent X avatar sanitizer rejects post media and deceptive hosts", () => {
  assert.equal(sanitizeXAvatarEvidenceUrl("https://pbs.twimg.com/media/post.jpg"), null);
  assert.equal(sanitizeXAvatarEvidenceUrl("https://pbs.twimg.com.evil.test/profile_images/no.jpg"), null);
  assert.equal(sanitizeXAvatarEvidenceUrl("http://pbs.twimg.com/profile_images/no.jpg"), null);
  assert.equal(
    sanitizeXAvatarEvidenceUrl("https://pbs.twimg.com/profile_images/1/yes.jpg?name=normal"),
    "https://pbs.twimg.com/profile_images/1/yes.jpg?name=normal",
  );
});
