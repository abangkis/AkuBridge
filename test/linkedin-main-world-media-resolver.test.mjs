import test from "node:test";
import assert from "node:assert/strict";
import { resolveLinkedInStructuredMediaInMainWorld } from "../linkedin-main-world-media-resolver.js";

test("LinkedIn MAIN-world resolver pairs progressive Video.js evidence with its activity", () => {
  const fixture = linkedInPlayerFixture({
    candidateUrn: "urn:li:activity:7490315383795568640",
    playbackUrl: "https://dms.licdn.com/playlist/D5605AQExample/mp4-720p-30fp-crf28/0/1784540717793?e=1786935600&v=beta&t=signed",
    posterUrl: "https://media.licdn.com/dms/image/v2/D5605AQExample/videocover-low/B56Example/0/1784540717793?e=1786935600&v=beta&t=signed",
  });

  const result = resolveLinkedInStructuredMediaInMainWorld(fixture.request);

  assert.equal(result.resolverVersion, "linkedin-main-world-video-v1");
  assert.deepEqual(result.candidates, [{
    candidateId: "linkedin:activity:7490315383795568640",
    media: [{
      kind: "video",
      url: fixture.posterUrl,
      posterUrl: fixture.posterUrl,
      playbackUrl: fixture.playbackUrl,
      playbackMode: "inline",
      width: 1280,
      height: 720,
      provenance: "linkedin_main_world_player",
    }],
  }]);
  assert.equal(JSON.stringify(result).includes("private post text"), false);
});

test("LinkedIn resolver filters requested activities and rejects adaptive or foreign sources", () => {
  const fixture = linkedInPlayerFixture({
    candidateUrn: "urn:li:share:7490315383795568641",
    playbackUrl: "https://dms.licdn.com/playlist/D5605AQExample/master.m3u8?e=1786935600",
    posterUrl: "https://attacker.example/poster.jpg",
  });
  fixture.player.foreign = "https://attacker.example/mp4-720p-30fp/video.mp4";

  const result = resolveLinkedInStructuredMediaInMainWorld({
    ...fixture.request,
    candidateIds: ["linkedin:share:7490315383795568641"],
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.rejectedAdaptiveURLCount, 1);
  assert.equal(JSON.stringify(result).includes("attacker.example"), false);
});

test("LinkedIn resolver assigns one recovered native identity only to its exact player ID", () => {
  const fixture = linkedInPlayerFixture({
    candidateUrn: null,
    playbackUrl: "https://dms.licdn.com/playlist/D5605AQExample/mp4-1080p-30fp-crf28/0/1784540717793?e=1786935600&v=beta&t=signed",
    posterUrl: "https://dms.licdn.com/playlist/vid/v2/D5605AQExample/thumbnail-low/B56Example/0/1784540717793?e=1786935600&v=beta&t=signed",
  });
  const assigned = resolveLinkedInStructuredMediaInMainWorld({
    ...fixture.request,
    candidateIds: ["linkedin:activity:7490315383795568642"],
    playerIds: ["linked-in-player-1"],
  });
  const unassigned = resolveLinkedInStructuredMediaInMainWorld({
    ...fixture.request,
    candidateIds: ["linkedin:activity:7490315383795568642"],
    playerIds: ["another-player"],
  });

  assert.deepEqual(assigned.candidates.map((candidate) => candidate.candidateId), [
    "linkedin:activity:7490315383795568642",
  ]);
  assert.equal(assigned.diagnostics.assignedCandidateCount, 1);
  assert.deepEqual(unassigned.candidates, []);
});

test("LinkedIn resolver does not treat a playlist MP4 as a poster", () => {
  const fixture = linkedInPlayerFixture({
    candidateUrn: "urn:li:activity:7490315383795568643",
    playbackUrl: "https://dms.licdn.com/playlist/vid/v2/D5605AQExample/mp4-720p-30fp-crf28/0/1784540717793",
    posterUrl: "https://dms.licdn.com/playlist/vid/v2/D5605AQExample/mp4-360p-30fp-crf28/0/1784540717793",
  });

  const result = resolveLinkedInStructuredMediaInMainWorld(fixture.request);

  assert.deepEqual(result.candidates, []);
});

function linkedInPlayerFixture({ candidateUrn, playbackUrl, posterUrl }) {
  const video = {
    videoWidth: 1280,
    videoHeight: 720,
    getBoundingClientRect: () => ({ width: 550, height: 309 }),
  };
  const container = {
    getAttribute: () => null,
    querySelectorAll: () => [],
  };
  const root = {
    id: "linked-in-player-1",
    matches: (selector) => selector === "[data-vjs-player]",
    closest: () => container,
    querySelector: (selector) => selector === "video" ? video : null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 550, height: 309 }),
    parentElement: null,
  };
  const player = {
    currentSources: () => [{ src: playbackUrl, type: "video/mp4" }],
    trackingState: {
      contextUrns: candidateUrn ? [candidateUrn] : [],
      assetUrn: "urn:li:video:7490315383795568999",
      privateText: "private post text",
    },
    presentation: { posterUrl },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === "[data-vjs-player]" ? [root] : [];
    },
  };
  return {
    player,
    playbackUrl,
    posterUrl,
    request: {
      document,
      videojs: { getPlayer: (id) => id === root.id ? player : null },
      maxTraversalNodes: 500,
    },
  };
}
