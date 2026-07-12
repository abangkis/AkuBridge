import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("LinkedIn embed target URNs become canonical native-post URLs", () => {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "linkedin-permalink-policy.js"), "utf8"),
    context,
  );
  const policy = context.AkuLinkedInPermalinkPolicy;
  assert.equal(
    policy.canonicalFromEmbedHref(
      "https://www.linkedin.com/preload/embed-modal/?targetUrn=urn%3Ali%3Ashare%3A7480750450749927424",
    ),
    "https://www.linkedin.com/feed/update/urn:li:share:7480750450749927424/",
  );
  assert.equal(
    policy.canonicalFromEmbedHref(
      "https://www.linkedin.com/preload/embed-modal/?targetUrn=urn%3Ali%3Aactivity%3A1234567890",
    ),
    "https://www.linkedin.com/feed/update/urn:li:activity:1234567890/",
  );
  assert.equal(policy.canonicalFromEmbedHref("https://evil.example/?targetUrn=urn:li:share:1"), null);
  assert.equal(policy.canonicalFromEmbedHref("https://www.linkedin.com/feed/"), null);
});
