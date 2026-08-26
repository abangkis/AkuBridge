import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseSourceTab,
  expectedFeedUrl,
  isBridgeOwnedFeedUrl,
  isCanonicalFeedUrl,
} from "../source-tab-policy.js";

test("Catch Up prefers a canonical LinkedIn feed over a newer profile tab", () => {
  const selected = chooseSourceTab(
    [
      {
        id: 1,
        url: "https://www.linkedin.com/feed/",
        lastAccessed: 100,
      },
      {
        id: 2,
        url: "https://www.linkedin.com/in/example/",
        lastAccessed: 200,
        active: true,
      },
    ],
    { source: "linkedin", mode: "catch_up" },
  );

  assert.equal(selected?.id, 1);
});

test("Catch Up rejects a profile when no canonical feed tab is open", () => {
  const selected = chooseSourceTab(
    [{ id: 2, url: "https://www.linkedin.com/in/example/", active: true }],
    { source: "linkedin", mode: "catch_up" },
  );

  assert.equal(selected, null);
  assert.equal(expectedFeedUrl("linkedin"), "https://www.linkedin.com/feed/");
  assert.equal(isCanonicalFeedUrl("https://x.com/home", "x"), true);
});

test("Manual Live may use the active source page", () => {
  const selected = chooseSourceTab(
    [
      { id: 1, url: "https://www.linkedin.com/feed/", lastAccessed: 200 },
      { id: 2, url: "https://www.linkedin.com/in/example/", lastAccessed: 100, active: true },
    ],
    { source: "linkedin", mode: "manual_live" },
  );

  assert.equal(selected?.id, 2);
});

test("Bridge ownership excludes native posts but retains explicit feed redirects", () => {
  assert.equal(isBridgeOwnedFeedUrl("https://x.com/aku/status/123", "x"), false);
  assert.equal(
    isBridgeOwnedFeedUrl("https://www.linkedin.com/feed/update/urn:li:activity:123", "linkedin"),
    false,
  );
  assert.equal(isBridgeOwnedFeedUrl("https://www.facebook.com/home.php", "facebook"), true);
  assert.equal(isBridgeOwnedFeedUrl("https://www.facebook.com/posts/123", "facebook"), false);
});
