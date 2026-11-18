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
  const container = { isConnected: true, contains: node => node === container,
    querySelectorAll: () => [], getAttribute: () => null, closest: () => null, matches: () => false,
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
  const context = vm.createContext({ document, window: { document, location, innerWidth: 1200, innerHeight: 1000 },
    getComputedStyle: node => node.style ?? ({display:'block',visibility:'visible',opacity:'1'}), location, URL, decodeURIComponent, Date });
  for (const file of ["source-adapter-runtime.js", "linkedin-permalink-policy.js", "diagnostics/linkedin-recovery.js", "adapters/linkedin-adapter.js"]) {
    vm.runInContext(fs.readFileSync(new URL(file, root), "utf8"), context);
  }
  const adapter = context.AkuSourceAdapters.get("linkedin");
  const helpers = { findPermalinkDetails: () => null, isVisibleInViewport: node => node.visible !== false,
    diagnosticSnapshotIndex: 0,
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

function blocker(kind, { ancestorARIAHidden = false, throws = false } = {}) {
  const ancestor = ancestorARIAHidden ? { parentElement: null, hasAttribute: () => false,
    getAttribute: name => name === 'aria-hidden' ? 'true' : null } : null;
  return { visible: true, id: 'Private-dom-id',
    matches(selector) { if (throws) throw Error('Private DOM error'); return selector === `[role="${kind}"]`; },
    getAttribute: () => null, hasAttribute: () => false, parentElement: ancestor,
    getBoundingClientRect: () => ({ width: 200, height: 100, top: 10, bottom: 110, left: 10, right: 210 }),
  };
}

test('blocker diagnostics preserve menu short-circuit, unknown dialogs and zero interactions', async () => {
  const s = scenario(); s.menus.push(blocker('menu'));
  const calls = []; const query = s.helpers.isVisibleInViewport;
  s.helpers.isVisibleInViewport = node => { calls.push(node); return query(node); };
  const result = await s.recover();
  assert.equal(result.url, null); assert.equal(result.blockerDiagnostic.menuCount, 1);
  assert.equal(result.blockerDiagnostic.dialogCount, null);
  assert.equal(result.blockerDiagnostic.complete, false);
  assert.equal(result.blockerDiagnostic.samples[0].guardVisible, true);
  assert.equal(result.blockerDiagnostic.samples[0].selector, 'role_menu');
  assert.equal(calls.length, 1); assert.equal(s.state.menuClicks + s.state.embedClicks + s.state.closeClicks, 0);
  assert.doesNotMatch(JSON.stringify(result.blockerDiagnostic), /Private|https:|urn:|Joel|Hussein/);
});

test('blocker diagnostics retain ancestor ARIA evidence separately without relaxing the visible-dialog guard', async () => {
  const s = scenario(); s.dialogs.push(blocker('dialog', { ancestorARIAHidden: true }));
  const result = await s.recover();
  assert.equal(result.url, null); assert.equal(result.blockerDiagnostic.menuCount, 0);
  assert.equal(result.blockerDiagnostic.dialogCount, 1);
  const sample = result.blockerDiagnostic.samples[0];
  assert.equal(sample.ancestors.ariaHidden, true);
  assert.equal(sample.ancestors.hiddenAttribute, false); assert.equal(sample.ancestors.inert, false);
  assert.equal(sample.ariaHidden, false);
  assert.equal(result.blockerDiagnostic.phase, 'pre_recovery_guard');
  assert.equal(result.blockerDiagnostic.snapshotIndex, 0); assert.equal(result.blockerDiagnostic.candidateIndex, 0);
  assert.equal(result.blockerDiagnostic.samples[0].guardVisible, true);
  assert.equal(result.blockerDiagnostic.complete, true);
  assert.equal(s.state.menuClicks + s.state.closeClicks, 0);
});

test('throwing diagnostic reads preserve blocked recovery and mark the observation incomplete', async () => {
  const s = scenario(); s.dialogs.push(blocker('dialog', { throws: true }));
  const result = await s.recover();
  assert.equal(result.url, null); assert.equal(result.blockerDiagnostic.complete, false);
  assert.equal(result.blockerDiagnostic.samples[0].selector, 'unknown');
  assert.equal(s.state.menuClicks + s.state.closeClicks, 0);
});

test('blocker diagnostics cap counts and samples without changing the blocking decision', async () => {
  const s = scenario(); s.menus.push(...Array.from({ length: 40 }, () => blocker('menu')));
  const result = await s.recover();
  assert.equal(result.url, null); assert.equal(result.blockerDiagnostic.menuCount, 32);
  assert.equal(result.blockerDiagnostic.samples.length, 4); assert.equal(result.blockerDiagnostic.complete, false);
  assert.equal(s.state.menuClicks + s.state.closeClicks, 0);
});

for (const relation of ['matches', 'different', 'absent']) {
  test(`ARIA relation ${relation} is diagnostic only and never dismisses an existing dialog`, async () => {
    const s = scenario(), node = blocker('dialog');
    node.getAttribute = name => name === 'aria-labelledby' && relation !== 'absent'
      ? relation === 'matches' ? s.button.id : 'Private-other-control' : null;
    s.dialogs.push(node);
    const result = await s.recover();
    assert.deepEqual(JSON.parse(JSON.stringify(result.blockerDiagnostic.samples[0].aria)), {labelledBy:relation,controls:'absent',owns:'absent'});
    assert.equal(result.url, null); assert.equal(s.state.menuClicks + s.state.closeClicks, 0);
    assert.doesNotMatch(JSON.stringify(result.blockerDiagnostic), /Private|post-control/);
  });
}

test('conflicting ARIA references remain independent evidence and never confer ownership', async () => {
  const s = scenario(), node = blocker('dialog'), attributes = s.button.getAttribute;
  node.getAttribute = name => name === 'aria-labelledby' ? s.button.id : null;
  s.button.getAttribute = name => name === 'aria-controls' ? 'Private-other-surface'
    : name === 'aria-owns' ? node.id : attributes(name);
  s.dialogs.push(node);
  const result = await s.recover();
  assert.deepEqual(JSON.parse(JSON.stringify(result.blockerDiagnostic.samples[0].aria)), {labelledBy:'matches',controls:'different',owns:'matches'});
  assert.equal(result.url, null); assert.equal(s.state.menuClicks + s.state.closeClicks, 0);
  assert.doesNotMatch(JSON.stringify(result.blockerDiagnostic), /Private|post-control/);
});

test('ancestor opacity and semantic attributes are observed independently with a bounded traversal', async () => {
  const s = scenario(), node = blocker('dialog');
  node.hasAttribute = name => name === 'hidden';
  node.parentElement = {parentElement:null,style:{display:'block',visibility:'visible',opacity:'0'},
    hasAttribute:name=>name==='inert',getAttribute:name=>name==='aria-hidden'?'true':null};
  s.dialogs.push(node);
  const result = await s.recover(), sample = result.blockerDiagnostic.samples[0];
  assert.equal(sample.opacityPositive,true); assert.equal(sample.hiddenAttribute,true);
  assert.equal(sample.ancestors.opacityZero,true); assert.equal(sample.ancestors.ariaHidden,true);
  assert.equal(sample.ancestors.inert,true); assert.equal(sample.ancestors.hiddenAttribute,false);
  assert.equal(sample.ancestors.inspected,1); assert.equal(sample.ancestors.complete,true);
  assert.equal(result.url,null); assert.equal(s.state.menuClicks + s.state.closeClicks,0);
});

test('ancestor depth limit and throwing reads preserve unknown values and blocked capture', async () => {
  const s=scenario(),node=blocker('dialog');let current=null;
  for(let n=0;n<20;n++)current={parentElement:current,hasAttribute:()=>false,getAttribute:()=>null};
  node.parentElement=current;s.dialogs.push(node);
  let result=await s.recover(), ancestors=result.blockerDiagnostic.samples[0].ancestors;
  assert.equal(ancestors.inspected,16);assert.equal(ancestors.complete,false);
  assert.equal(ancestors.opacityZero,null);assert.equal(result.blockerDiagnostic.complete,false);
  Object.defineProperty(node,'parentElement',{get(){throw Error('Private ancestor');}});
  result=await s.recover();ancestors=result.blockerDiagnostic.samples[0].ancestors;
  assert.equal(ancestors.complete,false);assert.equal(ancestors.hiddenAttribute,null);
  assert.equal(result.url,null);assert.equal(s.state.menuClicks+s.state.closeClicks,0);
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
    capturePolicy: { platformIdFromCandidates: (_source, values) => adapter.platformIdFromCandidates(values) },
    findContentRoot: () => s.body, findMedia: () => [], findAvatar: () => null,
  });
  const source = fs.readFileSync(new URL('content-script.js', root), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  function extractBlock('), source.indexOf('  function normalizeQuotedPost(')), context);
  const extract = () => context.extractBlock(s.container, 'linkedin', 4000, null, recovered);
  assert.equal(extract().permalink, joel.permalink);
  assert.equal(extract().text, joel.text);
  s.state.author = mixed.author; s.state.text = mixed.text;
  assert.equal(extract(), null);
});
