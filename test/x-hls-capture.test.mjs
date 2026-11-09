import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const asset = "2119481355943948288";
const quoteAsset = "2119471570100113408";
const poster = `https://pbs.twimg.com/amplify_video_thumb/${asset}/img/fixture.jpg`;
const stream = `https://video.twimg.com/amplify_video/${asset}/`;
const playlist = stream + "pl/fixture.m3u8?tag=12";
const quotePlaylist = `https://video.twimg.com/amplify_video/${quoteAsset}/pl/fixture.m3u8`;

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");

function fixture(resources, directPlayback = "blob:https://x.com/fixture") {
  const adapter = {
    mediaHosts: ["pbs.twimg.com", "video.twimg.com"],
    mediaRendering: { trustedVideo: true },
  };
  const context = vm.createContext({
    URL,
    performance: { getEntriesByType: type => type === "resource" ? resources : [] },
    AkuSourceAdapters: { get: () => adapter },
    sourceAdapters: { get: () => adapter },
    normalizeHttpUrl: value => value,
    renderedBackgroundUrl: () => null,
  });
  for (const file of ["bounded-capture-policy.js", "media-post-processor.js"]) {
    vm.runInContext(read(file), context);
  }
  context.capturePolicy = context.AkuBoundedCapturePolicy;
  const content = read("content-script.js");
  vm.runInContext(content.slice(content.indexOf("  function findMedia("), content.indexOf("  function findPermalink(")), context);
  const video = (posterURL, currentSrc) => ({
    poster: posterURL,
    currentSrc,
    getAttribute: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  });
  const primary = video(poster, directPlayback);
  const quoted = video(poster.replace(asset, quoteAsset), "blob:https://x.com/quote");
  const article = { querySelectorAll: selector => selector === "video" ? [primary, quoted] : [] };
  const media = context.findMedia(article, "x", { excludeRoot: { contains: node => node === quoted } });
  return { media, processor: context.AkuMediaPostProcessor };
}

test("Ananth-shaped X article captures the observed master playlist for its video asset", () => {
  const { media } = fixture([
    { name: playlist, responseStatus: 0 },
    { name: quotePlaylist },
    { name: stream + "pl/avc1/640x360/variant.m3u8" },
    { name: stream + "vid/avc1/init.mp4" },
    { name: stream + "pl/failed.m3u8", responseStatus: 403 },
  ]);
  assert.equal(media.length, 1);
  assert.equal(media[0].posterUrl, poster);
  assert.equal(media[0].playbackUrl, playlist);
  assert.equal(media[0].playbackMode, "inline");
  assert.equal(JSON.parse(JSON.stringify(media))[0].playbackUrl, playlist);
});

test("X retains the poster if only foreign, failed, or nested playlists were observed", () => {
  const { media } = fixture([
    { name: quotePlaylist },
    { name: stream + "pl/avc1/640x360/variant.m3u8" },
    { name: stream + "pl/not%2fmaster.m3u8" },
    { name: stream + "pl/denied.m3u8", responseStatus: 403 },
  ]);
  assert.equal(media.length, 1);
  assert.equal(media[0].playbackMode, "native");
  assert.equal(media[0].playbackUrl, null);
});

test("progressive X playback outranks HLS from either DOM or structured evidence", () => {
  const mp4 = stream + "vid/640x360/fixture.mp4";
  const { media: hlsMedia, processor } = fixture([{ name: playlist }]);
  const { media: mp4Media } = fixture([{ name: playlist }], mp4);
  assert.equal(mp4Media[0].playbackUrl, mp4);
  assert.equal(processor.process("x", hlsMedia, mp4Media).media[0].playbackUrl, mp4);
  assert.equal(processor.process("x", mp4Media, hlsMedia).media[0].playbackUrl, mp4);
});
