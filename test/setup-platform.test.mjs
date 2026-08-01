import test from "node:test";
import assert from "node:assert/strict";

import {
  detectSetupPlatform,
  SETUP_PLATFORMS,
} from "../setup-platform.js";

test("setup detects Windows from modern and legacy Chrome platform signals", () => {
  assert.equal(
    detectSetupPlatform({ userAgentData: { platform: "Windows" } }),
    SETUP_PLATFORMS.WINDOWS,
  );
  assert.equal(detectSetupPlatform({ platform: "Win32" }), SETUP_PLATFORMS.WINDOWS);
});

test("setup detects macOS and Linux without treating unknown platforms as Windows", () => {
  assert.equal(detectSetupPlatform({ platform: "MacIntel" }), SETUP_PLATFORMS.MACOS);
  assert.equal(detectSetupPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), SETUP_PLATFORMS.LINUX);
  assert.equal(detectSetupPlatform({}), SETUP_PLATFORMS.UNKNOWN);
});
