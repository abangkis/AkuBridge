import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL("fixtures/linkedin-joel-hussein-recovery-binding.json", import.meta.url)));
const [joel, mixed, laterJoel] = fixture.cases.map(value => value.block);
const husseinURL = "https://www.linkedin.com/feed/update/urn:li:share:7526896755959910400/";

// Persisted fields are real; DOM nodes and transitions are reconstructed.
function scenario({ block = joel, url = block.permalink, embed = false, onOpen, onEmbed } = {}) {
  const state = { author: block.author, text: block.text, menuClicks: 0, embedClicks: 0, closeClicks: 0 };
  const location = { href: "https://www.linkedin.com/feed/", hostname: "www.linkedin.com", pathname: "/feed/" };
  const body = { get innerText() { return state.text; }, querySelectorAll: () => [] };
  const button = { id: "post-control", isConnected: true,
    getAttribute: name => name === "aria-label" ? `Open control menu for post by ${state.author}` : null,
    click() { state.menuClicks++; menu.visible = !menu.visible; if (menu.visible) onOpen?.(api); },
  };
  const container = { isConnected: true,
    querySelector(selector) {
      if (selector === 'button[aria-label^="Open control menu for post by"]') return button;
      if (selector === '[data-testid="expandable-text-box"]') return body;
      return null;
    },
  };
  const link = value => Object.assign(new URL(value), { visible: true });
  const close = { getAttribute: name => name === "aria-label" ? "Close" : null,
    click() { state.closeClicks++; dialog.visible = false; } };
  const action = { id: "embed-control", innerText: "Embed this post", visible: true, getAttribute: () => null,
    click() { state.embedClicks++; menu.visible = false; dialog.visible = true; onEmbed?.(api); } };
  const menu = { id: "post-menu", visible: false, links: embed ? [] : [link(url)], actions: [action],
    getAttribute: () => null,
    querySelectorAll(selector) { return selector === 'a[href], [role="menuitem"][href]' ? this.links : this.actions; },
  };
  const code = value => ({ value: `<iframe src="${value.replace('/feed/update/', '/embed/feed/update/')}"></iframe>`, getAttribute: () => null });
  const dialog = { visible: false, nodes: [code(url)], getAttribute: () => null,
    querySelectorAll(selector) { return selector === 'button, [role="button"]' ? [close] : this.nodes; } };
  const menus = [], dialogs = [];
  const document = { querySelectorAll(selector) {
    if (selector === '[role="menu"]') return [...menus, ...(state.menuClicks ? [menu] : [])];
    if (selector === '[role="dialog"], [data-test-modal], .artdeco-modal') return [...dialogs, ...(state.embedClicks ? [dialog] : [])];
    return [];
  } };
  const context = vm.createContext({ document, window: { document, location }, location, URL, decodeURIComponent, Date });
  for (const file of ["source-adapter-runtime.js", "linkedin-permalink-policy.js", "adapters/linkedin-adapter.js"]) {
    vm.runInContext(fs.readFileSync(new URL(file, root), "utf8"), context);
  }
  const adapter = context.AkuSourceAdapters.get("linkedin");
  const helpers = { findPermalinkDetails: () => null, isVisibleInViewport: node => node.visible !== false,
    async waitForValue(read, attempts) { for (let n = 0; n < attempts; n++) { const value = read(); if (value) return value; } return null; },
  };
  const api = { state, menu, dialog, menus, dialogs, button, body, container, adapter, helpers, location, link, code,
    async recover() { return (await adapter.recoverPermalinks([container], Date.now() + 5000, helpers)).get(container); } };
  return api;
}

test('persisted Joel captures match while intermediate Hussein evidence carries Joel identity', () => {
  assert.equal(joel.text, laterJoel.text);
  assert.notEqual(mixed.author, joel.author); assert.notEqual(mixed.text, joel.text);
  assert.equal(mixed.permalink, joel.permalink); assert.equal(mixed.evidenceKey, joel.evidenceKey);
});

for (const embed of [false, true]) {
  test(`fresh owned ${embed ? 'dialog' : 'menu'} recovery produces a nontransferable binding`, async () => {
    const s = scenario({ embed }); const result = await s.recover();
    assert.equal(result.url, joel.permalink);
    assert.equal(s.adapter.validateRecoveredPermalink(s.container, result), true);
    assert.equal(s.adapter.validateRecoveredPermalink({}, result), false);
    assert.equal(s.adapter.validateRecoveredPermalink(s.container, { ...result }), false);
    assert.equal(s.menu.visible, false); assert.equal(s.dialog.visible, false);
    assert.equal(s.state.closeClicks, embed ? 1 : 0);
  });
}

test('Hussein never consumes or closes a stale visible Joel menu', async () => {
  const s = scenario({ block: mixed }); s.menus.push({ ...s.menu, visible: true });
  assert.equal((await s.recover()).url, null); assert.equal(s.state.menuClicks, 0); assert.equal(s.state.closeClicks, 0);
});

test('a hidden stale Joel URN cannot become Hussein identity', async () => {
  const s = scenario({ block: mixed }); s.menus.push({ ...s.menu, visible: false });
  assert.equal((await s.recover()).url, null);
});

test('fresh Hussein URL is recovered despite unrelated hidden Joel content', async () => {
  const s = scenario({ block: mixed, url: husseinURL });
  s.menus.push({ ...s.menu, visible: false, links: [s.link(joel.permalink)] });
  assert.equal((await s.recover()).url, husseinURL);
});

for (const surface of ['menu', 'dialog']) {
  test(`conflicting native URNs in the opened ${surface} stay unavailable`, async () => {
    const s = scenario({ embed: surface === 'dialog' });
    if (surface === 'menu') s.menu.links.push(s.link(husseinURL)); else s.dialog.nodes.push(s.code(husseinURL));
    assert.equal((await s.recover()).url, null);
  });
}

test('a hidden stale embed dialog cannot supply Joel URL to Hussein', async () => {
  const s = scenario({ block: mixed, embed: true }); s.dialogs.push({ ...s.dialog, visible: false });
  assert.equal((await s.recover()).url, null);
});

test('a menu labelled for another post is neither accepted nor closed', async () => {
  const s = scenario(); s.menu.getAttribute = name => name === 'aria-labelledby' ? 'another-control' : null;
  assert.equal((await s.recover()).url, null); assert.equal(s.state.menuClicks, 1);
});

test('an explicitly foreign dialog is neither accepted nor closed', async () => {
  const s = scenario({ embed: true }); s.dialog.getAttribute = name => name === 'aria-labelledby' ? 'foreign-action' : null;
  assert.equal((await s.recover()).url, null); assert.equal(s.state.closeClicks, 0);
});

test('multiple newly visible menus provide no unique interaction owner', async () => {
  const s = scenario({ onOpen(s) { s.menus.push({ ...s.menu, visible: true }); } });
  assert.equal((await s.recover()).url, null);
});

for (const mutation of ['author', 'text', 'route', 'disconnected', 'button']) {
  test(`binding rejects a recycled container after ${mutation} changes`, async () => {
    const s = scenario(); const result = await s.recover(); assert.equal(result.url, joel.permalink);
    if (mutation === 'author') s.state.author = mixed.author;
    if (mutation === 'text') s.state.text = mixed.text;
    if (mutation === 'route') s.location.href += '?changed';
    if (mutation === 'disconnected') s.container.isConnected = false;
    if (mutation === 'button') s.button.isConnected = false;
    assert.equal(s.adapter.validateRecoveredPermalink(s.container, result), false);
  });
}

test('owned expansion can extend the original text without invalidating recovery', async () => {
  const s = scenario(); s.state.text = joel.text.slice(0, 240) + '… See more';
  const result = await s.recover(); assert.equal(result.url, joel.permalink); s.state.text = joel.text;
  assert.equal(s.adapter.validateRecoveredPermalink(s.container, result), true);
});

test('owner replacement while awaiting embed never produces a bound URL', async () => {
  const s = scenario({ embed: true, onEmbed(s) { s.state.author = mixed.author; s.state.text = mixed.text; } });
  assert.equal((await s.recover()).url, null); assert.equal(s.state.closeClicks, 0);
});

test('a mutated URL or newly conflicting native ID invalidates a recovered record', async () => {
  const s = scenario(); const result = await s.recover();
  result.url = husseinURL;
  assert.equal(s.adapter.validateRecoveredPermalink(s.container, result), false);
  result.url = joel.permalink;
  s.container.getAttribute = name => name === 'data-urn' ? 'urn:li:share:7526896755959910400' : null;
  assert.equal(s.adapter.validateRecoveredPermalink(s.container, result), false);
});

test('direct native evidence and an expired budget cause no recovery interaction', async () => {
  const s = scenario(); s.helpers.findPermalinkDetails = () => ({ url: joel.permalink });
  assert.equal(await s.recover(), undefined); assert.equal(s.state.menuClicks, 0); s.helpers.findPermalinkDetails = () => null;
  const result = await s.adapter.recoverPermalinks([s.container], Date.now() - 1, s.helpers);
  assert.equal(result.get(s.container).url, null); assert.equal(s.state.menuClicks, 0);
});

test('Windowed production extraction rejects stale recovery before binding text to its URL', async () => {
  const s = scenario(); const recovered = await s.recover();
  const adapter = { ...s.adapter, extractText: () => s.state.text, extractSemantics: () => ({}),
    extractPresentation: () => ({}), extractAttachments: () => [], extractDirectContext: () => [],
    findAuthor: () => s.state.author };
  const context = vm.createContext({
    sourceAdapters: { get: () => adapter },
    structuredText: value => typeof value === 'string' ? value : value?.innerText ?? '',
    compactText: value => String(value ?? '').trim(),
    normalizeHttpUrl: value => value || null, normalizeHttpsUrl: value => value || null,
    findPermalinkDetails: () => null, normalizeDate: () => null, normalizeQuotedPost: () => null,
    legacyExpansionState: () => 'unknown', capturePrimitives: { textCompleteness: () => 'unknown' },
    findContentRoot: () => s.body, findMedia: () => [], findAvatar: () => null,
    findPlatformId: (_container, _source, url) => url === joel.permalink ? joel.platformId : null,
  });
  const source = fs.readFileSync(new URL('content-script.js', root), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  function extractBlock('), source.indexOf('  function normalizeQuotedPost(')), context);
  const extract = () => context.extractBlock(s.container, 'linkedin', 4000, null, recovered);
  assert.equal(extract().permalink, joel.permalink);
  assert.equal(extract().text, joel.text);
  s.state.author = mixed.author; s.state.text = mixed.text;
  assert.equal(extract(), null);
});
