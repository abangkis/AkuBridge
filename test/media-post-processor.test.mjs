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

function processorContext() {
  const context = vm.createContext({ URL, Map, Set, Object, Number, String });
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
