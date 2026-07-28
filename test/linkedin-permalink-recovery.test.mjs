import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("LinkedIn recovers a native permalink through bounded embed dialog evidence", async () => {
  let menuVisible = false;
  let dialogVisible = false;
  let menuClicks = 0;
  let embedClicks = 0;
  let closeClicks = 0;

  const menuButton = {
    click() {
      menuClicks += 1;
      menuVisible = !menuVisible;
    },
  };
  const embedAction = {
    innerText: "Embed this post",
    getAttribute(name) {
      return name === "aria-label" ? "Embed this post" : null;
    },
    click() {
      embedClicks += 1;
      menuVisible = false;
      dialogVisible = true;
    },
  };
  const embedCode = {
    value: '<iframe src="https://www.linkedin.com/embed/feed/update/urn%3Ali%3Ashare%3A7480750450749927424"></iframe>',
    getAttribute() { return null; },
  };
  const closeButton = {
    getAttribute(name) {
      return name === "aria-label" ? "Close" : null;
    },
    click() {
      closeClicks += 1;
      dialogVisible = false;
    },
  };
  const dialog = {
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return [closeButton];
      return [embedCode];
    },
  };
  const menu = {};
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="menu"] a[href], [role="menu"] [role="menuitem"][href]') return [];
      if (selector === '[role="menu"] [role="menuitem"], [role="menu"] button') {
        return menuVisible ? [embedAction] : [];
      }
      if (selector === '[role="dialog"], [data-test-modal], .artdeco-modal') {
        return dialogVisible ? [dialog] : [];
      }
      if (selector === '[role="menu"]') return menuVisible ? [menu] : [];
      return [];
    },
  };
  const context = browserContext(document);
  run(context, "source-adapter-runtime.js");
  run(context, "linkedin-permalink-policy.js");
  run(context, path.join("adapters", "linkedin-adapter.js"));
  const adapter = context.AkuSourceAdapters.get("linkedin");
  const container = candidate(menuButton);

  const recovered = await adapter.recoverPermalinks(
    [container],
    Date.now() + 5_000,
    recoveryHelpers(),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(recovered.get(container))), {
    url: "https://www.linkedin.com/feed/update/urn:li:share:7480750450749927424/",
    source: "embed_urn",
    reason: "",
  });
  assert.equal(menuClicks, 1);
  assert.equal(embedClicks, 1);
  assert.equal(closeClicks, 1);
  assert.equal(menuVisible, false);
  assert.equal(dialogVisible, false);
});

test("LinkedIn keeps direct menu URN recovery ahead of embed interaction", async () => {
  let menuVisible = false;
  let menuClicks = 0;
  let embedClicks = 0;
  const menuButton = {
    click() {
      menuClicks += 1;
      menuVisible = !menuVisible;
    },
  };
  const direct = new URL(
    "https://www.linkedin.com/preload/embed-modal/?targetUrn=urn%3Ali%3Aactivity%3A7480233401212473346",
  );
  const embedAction = {
    innerText: "Embed this post",
    getAttribute() { return null; },
    click() { embedClicks += 1; },
  };
  const menu = {};
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="menu"] a[href], [role="menu"] [role="menuitem"][href]') {
        return menuVisible ? [direct] : [];
      }
      if (selector === '[role="menu"] [role="menuitem"], [role="menu"] button') {
        return menuVisible ? [embedAction] : [];
      }
      if (selector === '[role="dialog"], [data-test-modal], .artdeco-modal') return [];
      if (selector === '[role="menu"]') return menuVisible ? [menu] : [];
      return [];
    },
  };
  const context = browserContext(document);
  run(context, "source-adapter-runtime.js");
  run(context, "linkedin-permalink-policy.js");
  run(context, path.join("adapters", "linkedin-adapter.js"));
  const adapter = context.AkuSourceAdapters.get("linkedin");
  const container = candidate(menuButton);

  const recovered = await adapter.recoverPermalinks(
    [container],
    Date.now() + 5_000,
    recoveryHelpers(),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(recovered.get(container))), {
    url: "https://www.linkedin.com/feed/update/urn:li:activity:7480233401212473346/",
    source: "embed_urn",
    reason: "",
  });
  assert.equal(menuClicks, 2);
  assert.equal(embedClicks, 0);
  assert.equal(menuVisible, false);
});

function browserContext(document) {
  const context = {
    document,
    window: {
      document,
      location: { hostname: "www.linkedin.com", pathname: "/feed/" },
    },
    URL,
    decodeURIComponent,
    Date,
  };
  context.globalThis = context;
  return vm.createContext(context);
}

function candidate(menuButton) {
  return {
    querySelector(selector) {
      if (selector === 'button[aria-label^="Open control menu for post by"]') return menuButton;
      return null;
    },
  };
}

function recoveryHelpers() {
  return {
    findPermalinkDetails() { return null; },
    isVisibleInViewport() { return true; },
    async waitForValue(read, attempts) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const value = read();
        if (value) return value;
      }
      return null;
    },
  };
}

function run(context, file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
}
