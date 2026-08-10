import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generic media-post processor enriches an existing poster with structured playback", () => {
  const context = processorContext();
  const processor = context.AkuMediaPostProcessor;
  const poster = {
    kind: "video",
    url: "https://scontent.example.fbcdn.net/poster.jpg",
    posterUrl: "https://scontent.example.fbcdn.net/poster.jpg",
    playbackUrl: null,
    playbackMode: "native",
    width: 640,
    height: 360,
  };
  const structured = {
    ...poster,
    playbackUrl: "https://scontent.example.fbcdn.net/video.mp4?oe=ABC",
    playbackMode: "inline",
    provenance: "facebook_structured_json",
  };

  const result = processor.process("facebook", [poster], [structured]);

  assert.equal(result.enrichedCount, 1);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].playbackMode, "inline");
  assert.equal(result.media[0].playbackUrl, structured.playbackUrl);
  assert.equal(result.media[0].posterUrl, poster.posterUrl);
});

test("generic evidence runtime keeps source identity and media validation in callbacks", () => {
  let now = 1_000;
  const context = processorContext();
  const runtime = context.AkuMediaPostProcessor.createEvidenceRuntime({
    source: "facebook",
    now: () => now,
    ttlMs: 1_000,
    normalizeCandidateId: (value) => /^facebook:post:\d+$/.test(value) ? value : null,
    candidateIdFromContainer: (container) => container.candidateId,
    normalizeMedia: (value) => value.playbackUrl?.includes("fbcdn.net") ? value : null,
  });
  const accepted = runtime.ingestStructured({ candidates: [{
    candidateId: "facebook:post:12345",
    media: [{
      kind: "video",
      url: "https://scontent.example.fbcdn.net/poster.jpg",
      playbackUrl: "https://scontent.example.fbcdn.net/video.mp4",
    }],
  }] });

  assert.equal(accepted, 1);
  assert.equal(runtime.lookupContainer({ candidateId: "facebook:post:12345" }).length, 1);
  now += 1_001;
  assert.equal(runtime.lookup("facebook:post:12345").length, 0);
  assert.equal(runtime.diagnostics().expired, 1);
});

test("deferred evidence inbox joins delivery with an active capture wait", async () => {
  const processor = processorContext().AkuMediaPostProcessor;
  const inbox = processor.createDeferredInbox();
  const waiting = inbox.wait("capture:facebook:1", 250);

  assert.equal(inbox.deliver("capture:facebook:1", { candidates: [{ candidateId: "facebook:post:1" }] }), true);
  assert.deepEqual(await waiting, { candidates: [{ candidateId: "facebook:post:1" }] });
  assert.equal(inbox.diagnostics().entryCount, 0);
});

test("deferred evidence inbox preserves early delivery until capture starts", async () => {
  const processor = processorContext().AkuMediaPostProcessor;
  const inbox = processor.createDeferredInbox();
  assert.equal(inbox.deliver("capture:x:2", { candidates: [] }), true);

  assert.deepEqual(await inbox.wait("capture:x:2", 250), { candidates: [] });
  assert.equal(inbox.deliver("invalid request id!", {}), false);
});

test("generic post processor enriches captured snapshots after parallel collection", () => {
  const processor = processorContext().AkuMediaPostProcessor;
  const posterUrl = "https://scontent.example.fbcdn.net/poster.jpg";
  const snapshots = [{ blocks: [{
    platformId: "facebook:post:123",
    contentKind: "video",
    media: [{ kind: "video", url: posterUrl, posterUrl, playbackMode: "native" }],
    mediaRecovery: { outcome: "primary_complete", trace: ["primary_complete"] },
  }] }];

  const result = processor.processSnapshots("facebook", snapshots, (candidateId) => (
    candidateId === "facebook:post:123"
      ? [{
          kind: "video",
          url: posterUrl,
          posterUrl,
          playbackUrl: "https://scontent.example.fbcdn.net/video.mp4",
          playbackMode: "inline",
        }]
      : []
  ));

  assert.equal(result.enrichedBlockCount, 1);
  assert.equal(snapshots[0].blocks[0].media[0].playbackMode, "inline");
  assert.equal(snapshots[0].blocks[0].mediaRecovery.method, "structured_deferred");
  assert.deepEqual(
    [...snapshots[0].blocks[0].mediaRecovery.trace],
    ["primary_complete", "structured_deferred_complete"],
  );
});

function processorContext() {
  const context = vm.createContext({ URL, Map, Set, Object, Number, String, setTimeout, clearTimeout });
  context.globalThis = context;
  context.AkuBoundedCapturePolicy = {
    normalizeMediaCandidates(_source, values) {
      const seen = new Set();
      return (Array.isArray(values) ? values : []).filter((value) => {
        const key = value?.url;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((value) => ({ ...value }));
    },
  };
  vm.runInContext(
    fs.readFileSync(path.join(root, "media-post-processor.js"), "utf8"),
    context,
  );
  return context;
}
