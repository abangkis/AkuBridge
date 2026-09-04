import assert from "node:assert/strict";
import test from "node:test";

import {
  createXMediaEvidenceStore,
  sanitizeXMediaEvidence,
} from "../x-media-evidence-store.js";

function fakeStorage() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, structuredClone(update)); },
  };
}

test("persistent X media evidence is sanitized, bounded, and lookup-only", async () => {
  const storage = fakeStorage();
  const store = createXMediaEvidenceStore(storage, { now: () => 1000, maxMedia: 2 });
  await store.put("https://x.com/example/status/123456", [
    {
      kind: "image",
      url: "https://pbs.twimg.com/media/first.jpg",
      alt: "must not persist",
      provenance: "x_response_graphql",
    },
    { kind: "image", url: "https://evil.example/media/second.jpg" },
    { kind: "image", url: "https://pbs.twimg.com/media/third.jpg" },
    { kind: "image", url: "https://pbs.twimg.com/media/fourth.jpg" },
  ]);
  const result = await store.lookup(["x:status:123456", "x:status:999999"]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].media.length, 2);
  assert.equal("alt" in result.candidates[0].media[0], false);
  assert.equal(result.candidates[0].media[0].provenance, "x_response_graphql");
  assert.equal(result.candidates[0].media[1].provenance, "observed_dom");
  assert.equal(JSON.stringify(storage.values).includes("evil.example"), false);
  assert.equal(JSON.stringify(storage.values).includes("must not persist"), false);
});

test("persistent X media evidence preserves bounded response provenance", async () => {
  const storage = fakeStorage();
  const store = createXMediaEvidenceStore(storage, { now: () => 1000 });
  await store.put("x:status:55555", [{
    kind: "image",
    url: "https://pbs.twimg.com/media/response.jpg",
    provenance: "x_response_graphql",
  }]);
  const result = await store.lookup(["x:status:55555"]);
  assert.equal(result.runtimeRevision, "x-media-evidence-store-v2");
  assert.equal(result.candidates[0].media[0].provenance, "x_response_graphql");
});

test("persistent X media evidence expires and keeps the newest candidates", async () => {
  let current = 1_000;
  const storage = fakeStorage();
  const store = createXMediaEvidenceStore(storage, {
    now: () => current,
    ttlMs: 1_000,
    maxCandidates: 2,
  });
  for (const id of ["11111", "22222", "33333"]) {
    await store.put(`x:status:${id}`, [{ url: `https://pbs.twimg.com/media/${id}.jpg` }]);
  }
  let result = await store.lookup(["x:status:11111", "x:status:22222", "x:status:33333"]);
  assert.deepEqual(result.candidates.map((value) => value.candidateId), ["x:status:22222", "x:status:33333"]);
  current = 2_001;
  result = await store.lookup(["x:status:22222", "x:status:33333"]);
  assert.equal(result.candidates.length, 0);
});

test("the sanitizer rejects profile avatars and deceptive hostnames", () => {
  assert.deepEqual(sanitizeXMediaEvidence([
    { url: "https://pbs.twimg.com/profile_images/avatar.jpg" },
    { url: "https://pbs.twimg.com.evil.example/media/fake.jpg" },
    {
      kind: "video",
      url: "https://video.twimg.com/ext_tw_video/example/clip.mp4",
      playbackUrl: "https://video.twimg.com/ext_tw_video/example/clip.mp4",
    },
    { url: "https://pbs.twimg.com/card_img/preview.jpg" },
  ]).map((value) => value.url), ["https://pbs.twimg.com/card_img/preview.jpg"]);
});

test("X image size variants consume one media slot", () => {
  const media = sanitizeXMediaEvidence([
    { url: "https://pbs.twimg.com/media/same.jpg" },
    { url: "https://pbs.twimg.com/media/same?format=jpg&name=small" },
    { url: "https://pbs.twimg.com/media/same?name=large&format=jpg" },
    { url: "https://pbs.twimg.com/media/other?format=jpg&name=large" },
  ]);
  assert.deepEqual(media.map((value) => value.url), [
    "https://pbs.twimg.com/media/same.jpg",
    "https://pbs.twimg.com/media/other?format=jpg&name=large",
  ]);
});

test("X media entities with distinct IDs remain separate", () => {
  const media = sanitizeXMediaEvidence([
    { url: "https://pbs.twimg.com/media/first.jpg" },
    { url: "https://pbs.twimg.com/media/second?format=jpg&name=small" },
  ]);

  assert.deepEqual(media.map((value) => value.url), [
    "https://pbs.twimg.com/media/first.jpg",
    "https://pbs.twimg.com/media/second?format=jpg&name=small",
  ]);
});
