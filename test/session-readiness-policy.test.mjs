import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_SESSION_MAX_TABS,
  createSourceSessionObservation,
  sourceSessionStateForTabs,
  sourceSessionStateFromReadiness,
} from "../session-readiness-policy.js";

test("session readiness maps adapter probes without treating permission as login", () => {
  assert.equal(sourceSessionStateFromReadiness({ state: "feed_ready" }), "ready");
  assert.equal(sourceSessionStateFromReadiness({ state: "feed_empty" }), "ready");
  assert.equal(sourceSessionStateFromReadiness({ state: "login_required" }), "login_required");
  assert.equal(sourceSessionStateFromReadiness({ state: "loading" }), "loading");
  assert.equal(sourceSessionStateFromReadiness({ state: "source_unavailable" }), "unavailable");
  assert.equal(sourceSessionStateFromReadiness({ state: "wrong_page" }), "not_observed");
  assert.equal(sourceSessionStateFromReadiness({ state: "page_shell" }), "unknown");
  assert.equal(sourceSessionStateFromReadiness(null), "unknown");
});

test("session state prefers an observed feed and is bounded across existing tabs", () => {
  assert.equal(sourceSessionStateForTabs([]), "not_observed");
  assert.equal(sourceSessionStateForTabs([
    { readiness: { state: "feed_ready" } },
    { readiness: { state: "login_required" } },
  ]), "ready");
  assert.equal(sourceSessionStateForTabs([
    { readiness: { state: "page_shell" } },
    { readiness: { state: "login_required" } },
  ]), "login_required");
  assert.equal(sourceSessionStateForTabs([
    { readiness: { state: "loading" } },
    { readiness: { state: "feed_empty" } },
  ]), "ready");
  assert.equal(sourceSessionStateForTabs([
    { readiness: { state: "loading" } },
  ]), "loading");
  assert.equal(sourceSessionStateForTabs([
    { readiness: { state: "source_unavailable" } },
  ]), "unavailable");
  assert.equal(SOURCE_SESSION_MAX_TABS, 3);
});

test("session observations expose bounded state and timestamp only", () => {
  const observation = createSourceSessionObservation({
    source: "linkedin",
    state: "ready",
    observedAt: "2026-08-23T00:00:00.000Z",
    tabCount: 99,
    detail: "observed",
  });
  assert.deepEqual(observation, {
    source: "linkedin",
    state: "ready",
    observedAt: "2026-08-23T00:00:00.000Z",
    tabCount: 3,
    detail: "observed",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(observation, "cookies"), false);
});
