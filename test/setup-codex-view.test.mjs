import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_SETUP_ACTIONS,
  codexSetupView,
} from "../setup-codex-view.js";

test("Codex waits for an explicit click without requiring the Sidecar server", () => {
  const state = codexSetupView({ state: "codex_unchecked" });
  assert.equal(state.actionKind, CODEX_SETUP_ACTIONS.CHECK);
  assert.equal(state.actionLabel, "Check Codex");
  assert.equal(state.actionDisabled, false);
  assert.equal(state.showConfirmation, false);
});

test("missing Codex presents download, install, sign-in, and retry guidance", () => {
  const state = codexSetupView({ state: "codex_not_found" });
  assert.equal(state.badge, "Not installed");
  assert.equal(state.showDownload, true);
  assert.equal(state.showInstructions, true);
  assert.equal(state.actionLabel, "Try again");
});

test("compatible Codex asks for confirmation only after detection", () => {
  const state = codexSetupView({ state: "codex_available" });
  assert.equal(state.available, true);
  assert.equal(state.badge, "Installed");
  assert.equal(state.showConfirmation, true);
  assert.equal(state.showDetectedDetail, true);
  assert.equal(state.actionDisabled, true);
});
