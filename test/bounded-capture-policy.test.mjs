import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadPolicy() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(projectRoot, "bounded-capture-policy.js"), "utf8"),
    context,
  );
  return context.AkuBoundedCapturePolicy;
}

test("native capture policy clamps every browser-movement budget", () => {
  const policy = loadPolicy();
  const plan = policy.normalizeCapturePlan({
    source: "x",
    scrolls: 99,
    scrollFraction: 0.1,
    scrollSettleMs: 99_999,
    captureTimeoutMs: 99_999,
    maxBlocksPerSnapshot: 99,
    maxBlockCharacters: 99_999,
    restoreScroll: false,
  });

  assert.equal(plan.scrolls, 2);
  assert.equal(plan.scrollFraction, 0.5);
  assert.equal(plan.scrollSettleMs, 2_000);
  assert.equal(plan.captureTimeoutMs, 45_000);
  assert.equal(plan.maxBlocksPerSnapshot, 20);
  assert.equal(plan.maxBlockCharacters, 4_000);
  assert.equal(plan.restoreScroll, true);
  assert.equal(Object.isFrozen(plan), true);
});

test("candidate accounting collapses repeated posts across snapshots", () => {
  const policy = loadPolicy();
  const seen = new Set();

  assert.equal(
    policy.countNewCandidates(
      [
        { text: "First post", permalink: "https://x.com/example/status/1" },
        { text: "Second post", permalink: null },
      ],
      seen,
    ),
    2,
  );
  assert.equal(
    policy.countNewCandidates(
      [
        { text: "First post repeated", permalink: "https://x.com/example/status/1" },
        { text: "  second   post ", permalink: null },
        { text: "Third post", permalink: "https://x.com/example/status/3" },
      ],
      seen,
    ),
    1,
  );
});

test("the policy is loaded before the source content script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const sourceEntry = manifest.content_scripts.find((entry) =>
    entry.matches.includes("https://x.com/*"),
  );
  assert.deepEqual(sourceEntry.js, ["bounded-capture-policy.js", "content-script.js"]);

  const worker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert.match(worker, /files: \["bounded-capture-policy\.js", "content-script\.js"\]/);
});
