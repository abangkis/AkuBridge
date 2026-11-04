import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, files = {}) {
  const fixtureParent = path.join(projectRoot, "build", "extension-package-tests");
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "package-"));
  t.after(() => {
    if (path.dirname(root) !== fixtureParent || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) {
      throw new Error("Refusing fixture cleanup outside the ordinary project build directory.");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const entries = {
    "package.json": JSON.stringify({ type: "module", version: "1.2.3" }),
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "AkuBrowser",
      version: "1.2.3.0",
      version_name: "1.2.3",
      background: { service_worker: "runtime.js" },
      action: { default_popup: "popup.html" },
      icons: { 16: "icons/icon.png" },
      content_scripts: [{ js: ["content.js"], css: ["content.css"] }],
    }),
    "source-access-policy.js": [
      'export const sourceAccessDefinitions = () => [{ id: "fixture" }];',
      'export const registeredScriptsForSources = (ids) => ids.includes("fixture")',
      '  ? [{ js: ["registered.js"], css: ["registered.css"] }] : [];',
    ].join("\n"),
    "scripts/verify-extension-package.mjs": fs.readFileSync(
      path.join(projectRoot, "scripts", "verify-extension-package.mjs"), "utf8",
    ),
    "runtime.js": 'import "./nested/dependency.js"; import "./test-helper.js"; import "./x-qa.js";',
    "nested/dependency.js": 'export { value } from "../shared.js";',
    "shared.js": "export const value = 1;",
    "popup.html": '<link href="popup.css"><script src="popup.js"></script>',
    "popup.css": "body {}",
    "popup.js": 'import { value } from "./shared.js";',
    "source-permission.html": "<!doctype html>",
    "capture-placeholder.html": "<!doctype html>",
    "icons/icon.png": Buffer.from([0, 1, 2, 3]),
    "content.js": "// Registered by manifest.",
    "content.css": "body {}",
    "registered.js": "// Registered by source policy.",
    "registered.css": "body {}",
    "test-helper.js": "// A production helper name is not a test suffix.",
    "x-qa.js": "// A production source name is not a test suffix.",
    "unused.test.js": "// Development-only file outside the closure.",
    "test/unused.test.mjs": "// Development-only test directory.",
    ...files,
  };
  for (const [relative, content] of Object.entries(entries)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return {
    root,
    verify: () => spawnSync(process.execPath, ["scripts/verify-extension-package.mjs"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000,
    }),
  };
}

test("extension package inventory follows manifest, source registry, HTML, and transitive imports", (t) => {
  const { root, verify } = fixture(t);
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  const expected = [
    "capture-placeholder.html", "content.css", "content.js", "icons/icon.png", "manifest.json",
    "nested/dependency.js", "popup.css", "popup.html", "popup.js", "registered.css",
    "registered.js", "runtime.js", "shared.js", "source-permission.html", "test-helper.js", "x-qa.js",
  ].map((file) => ({
    path: file,
    sha256: createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"),
  }));
  assert.deepEqual(inventory, {
    name: "AkuBrowser", version: "1.2.3", chromeVersion: "1.2.3.0", manifestVersion: 3,
    files: expected,
    fingerprint: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    writesArtifact: false,
  });
  const repeated = verify();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, result.stdout);
});

test("extension package verification rejects a missing transitive import", (t) => {
  const { verify } = fixture(t, { "runtime.js": 'import "./missing.js";' });
  const result = verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing extension file: missing\.js/);
});

test("extension package verification rejects referenced test directories", (t) => {
  const { verify } = fixture(t, { "runtime.js": 'import "./test/unused.test.mjs";' });
  const result = verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden packaged file: test\/unused\.test\.mjs/);
});

for (const file of ["worker.test.js", "worker.test.mjs", "worker.test.cjs", "nested/worker.test.js"]) {
  test(`extension package verification rejects referenced ${file}`, (t) => {
    const { verify } = fixture(t, {
      "runtime.js": `import "./${file}";`,
      [file]: "// A test must never enter the production package inventory.",
    });
    const result = verify();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`forbidden packaged file: ${file}`), result.stderr);
  });
}

for (const channel of ["HTML", "manifest", "source registry"]) {
  test(`extension package verification rejects a test referenced by ${channel}`, (t) => {
    const { root, verify } = fixture(t, { "worker.test.js": "// Development-only test." });
    if (channel === "HTML") {
      fs.writeFileSync(path.join(root, "popup.html"), '<script src="worker.test.js"></script>');
    } else if (channel === "manifest") {
      const manifestPath = path.join(root, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.background.service_worker = "worker.test.js";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } else {
      fs.writeFileSync(path.join(root, "source-access-policy.js"), [
        'export const sourceAccessDefinitions = () => [{ id: "fixture" }];',
        'export const registeredScriptsForSources = () => [{ js: ["worker.test.js"] }];',
      ].join("\n"));
    }
    const result = verify();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden packaged file: worker\.test\.js/);
  });
}
