import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("complete social candidates pass the generic quality profile", () => {
  const policy = loadPolicy();
  const report = policy.evaluateCandidate({
    candidate: completeCandidate(),
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    retriesRemaining: 1,
  });
  assert.equal(report.verdict, "complete");
  assert.equal(report.score, 1);
  assert.equal(report.issues.length, 0);
});

test("detected empty media is retryable and then degrades after the bounded retry", () => {
  const policy = loadPolicy();
  const candidate = { ...completeCandidate(), media: [] };
  const first = policy.evaluateCandidate({
    candidate,
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    retriesRemaining: 1,
  });
  assert.equal(first.verdict, "retryable");
  assert.equal(first.issues[0].field, "media");
  assert.equal(first.issues[0].observedState, "pending_hydration");

  const final = policy.evaluateCandidate({
    candidate,
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    attempt: 1,
    retriesRemaining: 0,
  });
  assert.equal(final.verdict, "usable_degraded");
  assert.equal(final.attempt, 1);
});

test("missing avatars are presentation warnings and never consume the retry budget", () => {
  const policy = loadPolicy();
  const report = policy.evaluateCandidate({
    candidate: { ...completeCandidate(), avatarUrl: null },
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    candidateKey: "x:status:1",
    retriesRemaining: 1,
  });
  assert.equal(report.verdict, "complete");
  assert.equal(report.candidateKey, "x:status:1");
  assert.equal(report.issues[0].field, "avatarUrl");
  assert.equal(report.issues[0].impact, "presentation");
  assert.equal(report.issues[0].recoverable, false);
});

test("a detected empty required author becomes invalid after recovery is exhausted", () => {
  const policy = loadPolicy();
  const candidate = { ...completeCandidate(), author: "" };
  const first = policy.evaluateCandidate({
    candidate,
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    retriesRemaining: 1,
  });
  assert.equal(first.verdict, "retryable");

  const final = policy.evaluateCandidate({
    candidate,
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    attempt: 1,
    retriesRemaining: 0,
  });
  assert.equal(final.verdict, "invalid");
  assert.equal(final.issues[0].severity, "critical");
});

test("explicitly not-exposed timestamps do not reduce quality", () => {
  const policy = loadPolicy();
  const report = policy.evaluateCandidate({
    candidate: { ...completeCandidate(), publishedAt: null },
    facts: { ...completeFacts(), publishedAtNotExposed: true },
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    retriesRemaining: 0,
  });
  assert.equal(report.verdict, "complete");
});

test("quality summaries preserve warnings without degrading the aggregate", () => {
  const policy = loadPolicy();
  const complete = policy.evaluateCandidate({
    candidate: completeCandidate(),
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
  });
  const degraded = policy.evaluateCandidate({
    candidate: { ...completeCandidate(), avatarUrl: null },
    facts: completeFacts(),
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
    attempt: 1,
  });
  const summary = policy.summarize([complete, degraded], { retryBudget: 1 });
  assert.equal(summary.verdict, "complete");
  assert.equal(summary.candidateReportCount, 2);
  assert.equal(summary.verdictCounts.complete, 2);
  assert.equal(summary.verdictCounts.usable_degraded, 0);
  assert.equal(summary.retryAttempts, 1);
});

test("native media evidence admits a post without a text caption", () => {
  const policy = loadPolicy();
  const report = policy.evaluateCandidate({
    candidate: {
      ...completeCandidate(),
      text: "",
      media: [{ kind: "image", url: "https://pbs.twimg.com/media/example.jpg" }],
    },
    facts: { ...completeFacts(), contentRootDetected: false, stableTextIdentity: false },
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
  });
  assert.equal(report.verdict, "complete");
  assert.deepEqual([...report.evidenceModalities], ["image"]);
  assert.equal(report.identitySource, "platform_id");
});

test("a block without any declared evidence modality is invalid", () => {
  const policy = loadPolicy();
  const report = policy.evaluateCandidate({
    candidate: { ...completeCandidate(), text: "", media: [], attachments: [], quotedPost: null },
    facts: { ...completeFacts(), contentRootDetected: false, mediaRootDetected: false },
    profileId: "social-post-v2",
    evidenceProfile: feedPostEvidenceProfile(),
  });
  assert.equal(report.verdict, "invalid");
  assert.equal(report.issues[0].field, "evidence");
});

function feedPostEvidenceProfile() {
  return {
    contentFamily: "feed_post",
    modalities: ["text", "image", "video", "attachment", "quoted_post"],
  };
}

function completeCandidate() {
  return {
    text: "A complete source post with enough stable text to identify the observed evidence.",
    author: "Example Author",
    platformId: "x:status:1",
    permalink: "https://x.com/example/status/1",
    avatarUrl: "https://pbs.twimg.com/profile_images/example.jpg",
    media: [{ kind: "image", url: "https://pbs.twimg.com/media/example.jpg" }],
    publishedAt: "2026-07-14T00:00:00.000Z",
  };
}

function completeFacts() {
  return {
    contentRootDetected: true,
    authorRootDetected: true,
    primaryAvatarRootDetected: true,
    mediaRootDetected: true,
    timestampSignalDetected: true,
    publishedAtNotExposed: false,
    stableTextIdentity: true,
  };
}

function loadPolicy() {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "capture-quality-policy.js"), "utf8"),
    context,
  );
  return context.AkuCaptureQualityPolicy;
}
