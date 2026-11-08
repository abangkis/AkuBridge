import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildSharedDOMEngine } from '../build.mjs';
import { assessDOM, SCHEMA_VERSION } from '../src/core.mjs';

const policy = {
  version: 'ledger-v1', layouts: ['ledger-card', 'ledger-compact'], postMarkers: ['bound-entry'],
  requiredPrimaryFields: ['author'], modalities: [
    { field: 'text', owner: 'primary' }, { field: 'media', owner: 'primary' }, { field: 'excerpt', owner: 'quote' },
  ],
};
const key = 'entry:opaque-17';
const claim = (value = key, owner = 'primary') => ({ key: value, owner, provenance: 'entry-binding' });
const present = (name, owner = 'primary', identityKey) => ({ name, owner, availability: 'present', identityKey });
const entry = overrides => ({ ref: 'row-1', visible: true, layout: 'ledger-card', identityClaims: [claim()],
  fields: [present('author'), present('text')], ...overrides });

function sample(candidates, overrides = {}) {
  const visible = candidates.filter(candidate => candidate.visible).length;
  return { scope: 'document-1', sampleSequence: 2, complete: true, settled: true, access: 'available',
    candidates, ...overrides, structure: { feedRoot: true, loading: false, empty: false,
      visibleStructuralCount: visible, offscreenStructuralCount: candidates.length - visible,
      markers: [{ name: 'bound-entry', count: visible }], ...overrides.structure } };
}

const evaluate = (current, rest = {}) => assessDOM({ schemaVersion: SCHEMA_VERSION, policy, current, ...rest });

test('a synthetic adapter binds custom elements to opaque identities without any browser globals', () => {
  const root = { querySelectorAll: selector => {
    assert.equal(selector, 'ledger-entry');
    return [{ getAttribute: name => ({ 'entry-key': key, 'entry-by': 'Fixture author' })[name],
      querySelector: name => name === 'ledger-content' ? { textContent: 'Fixture body' } : null }];
  } };
  const adapter = { probe: root => root.querySelectorAll('ledger-entry').map((node, index) => ({
    ref: `entry-${index}`, visible: true, layout: 'ledger-card', identityClaims: [claim(node.getAttribute('entry-key'))],
    fields: [node.getAttribute('entry-by') && present('author'),
      node.querySelector('ledger-content')?.textContent && present('text')].filter(Boolean),
  })) };
  const verdict = evaluate(sample(adapter.probe(root)));
  assert.equal(verdict.rendering, 'ready');
  assert.deepEqual(verdict.candidates[0].identity, { key, locator: null, provenance: ['entry-binding'] });
});

test('known mixed layouts accept equivalent identity claims and retain separate quote keys', () => {
  const quoteKey = 'entry:quote-3';
  const second = entry({ ref: 'row-2', layout: 'ledger-compact', identityClaims: [
    claim(), { ...claim(), provenance: 'alternate-binding', locator: 'urn:example:17' }, claim(quoteKey, 'quote'),
  ], fields: [present('author'), present('excerpt', 'quote', quoteKey)] });
  const verdict = evaluate(sample([entry(), second]));
  assert.equal(verdict.layout, 'mixed');
  assert.equal(verdict.diagnostic.counts.accepted, 2);
  assert.deepEqual(verdict.candidates[1].identity, {
    key, locator: 'urn:example:17', provenance: ['alternate-binding', 'entry-binding'],
  });
  assert.deepEqual(verdict.candidates[1].quoteKeys, [quoteKey]);
});

test('primary conflict, foreign field binding and target mismatch reject their candidates', () => {
  const conflict = entry({ identityClaims: [claim(), claim('entry:different')] });
  const media = entry({ ref: 'row-2', fields: [present('author'), present('media', 'primary', 'entry:foreign')] });
  const verdict = evaluate(sample([conflict, media]));
  assert.equal(verdict.integrity, 'conflict');
  assert.deepEqual(verdict.diagnostic.rejections, { identity_conflict: 1, ownership_conflict: 1 });
  assert.equal(evaluate(sample([entry()]), { expectedPrimaryKey: 'entry:different' }).candidates[0].reason,
    'unexpected_identity');
  const locators = ['urn:one', 'urn:two'].map(locator => ({ ...claim(), locator }));
  assert.equal(evaluate(sample([entry({ identityClaims: locators })])).candidates[0].reason, 'identity_conflict');
});

test('quote and unknown evidence cannot replace primary identity or author', () => {
  const quoteKey = 'entry:quote';
  const noIdentity = entry({ identityClaims: [claim(quoteKey, 'quote')] });
  const noAuthor = entry({ ref: 'row-2', identityClaims: [claim(), claim(quoteKey, 'quote')],
    fields: [present('author', 'quote', quoteKey), present('text')] });
  const unbound = entry({ ref: 'row-3', fields: [present('author'), present('excerpt', 'quote')] });
  const unknownOwner = entry({ ref: 'row-4', fields: [present('author', 'unknown'), present('text')] });
  assert.deepEqual(evaluate(sample([noIdentity, noAuthor, unbound, unknownOwner])).diagnostic.rejections,
    { missing_identity: 1, missing_required_field: 2, missing_content: 1 });
  assert.equal(evaluate(sample([entry({ fields: [present('author'), present('media')] })])).rendering, 'ready');
});

test('single, incomplete or cross-scope samples cannot establish DOM drift', () => {
  const candidate = entry({ layout: 'unseen-layout' });
  const current = sample([candidate]);
  const previous = sample([candidate], { sampleSequence: 1 });
  assert.equal(evaluate(current).rendering, 'inconclusive');
  assert.equal(evaluate(current, { previous }).rendering, 'dom_contract_suspected');
  for (const earlier of [{ ...previous, scope: 'new-document' }, { ...previous, complete: false },
    { ...previous, sampleSequence: 2 }, { ...previous, access: 'challenge_required' }]) {
    assert.equal(evaluate(current, { previous: earlier }).rendering, 'inconclusive');
  }
  const noPostEvidence = sample([candidate], { structure: { markers: [{ name: 'shell', count: 9 }] } });
  assert.equal(evaluate(noPostEvidence, { previous: { ...noPostEvidence, sampleSequence: 1 } }).rendering,
    'no_valid_candidates');
});

test('reports hydration only from loading or progressing fields on the same primary identity', () => {
  const shell = entry({ fields: [] });
  const previous = sample([shell], { sampleSequence: 1, settled: false });
  const next = sample([entry({ fields: [present('author')] })], { settled: false });
  assert.equal(evaluate(next, { previous }).rendering, 'hydrating');
  assert.equal(evaluate(next, { previous: { ...previous, scope: 'different-route' } }).rendering,
    'no_valid_candidates');
  const duplicate = sample([entry({ fields: [present('author'), present('author')] })], { settled: false });
  assert.equal(evaluate(duplicate, { previous: { ...next, sampleSequence: 1 } }).rendering, 'no_valid_candidates');
  assert.equal(evaluate(sample([shell], { structure: { loading: true } })).rendering, 'hydrating');
});

test('observed empty, unverified empty, incomplete, offscreen and access failures remain distinct', () => {
  assert.equal(evaluate(sample([], { structure: { empty: true } })).rendering, 'empty_observed');
  assert.equal(evaluate(sample([])).rendering, 'empty_unverified');
  assert.equal(evaluate(sample([], { complete: false, structure: { empty: true } })).rendering, 'incomplete_sample');
  assert.equal(evaluate(sample([entry({ visible: false })])).rendering, 'offscreen');
  const result = evaluate(sample([entry()], { access: 'challenge_required' }));
  assert.equal(result.diagnostic.code, 'challenge_required');
  assert.deepEqual(result.candidates, []);
});

test('probe failure is distinct from malformed, oversized and unsupported evidence', () => {
  assert.equal(evaluate(sample([], { probeFailed: true })).diagnostic.code, 'probe_failed');
  const partial = evaluate(sample([entry(), entry({ ref: 'row-2', probeFailed: true })]));
  assert.equal(partial.rendering, 'ready');
  assert.equal(partial.diagnostic.rejections.candidate_probe_failed, 1);
  const oversized = Array.from({ length: 65 }, (_, index) => entry({ ref: `row-${index}` }));
  assert.equal(evaluate(sample(oversized)).diagnostic.code, 'invalid_evidence');
  assert.equal(evaluate(sample([entry(), entry()])).diagnostic.code, 'invalid_evidence');
  assert.equal(evaluate(sample([entry({ fields: [() => true] })])).diagnostic.code, 'invalid_evidence');
  assert.equal(evaluate(sample([]), { schemaVersion: 999 }).diagnostic.code, 'unsupported_schema');
});

test('diagnostics exclude scope, identity, locators, content and arbitrary adapter labels', () => {
  const current = sample([entry({ ref: 'private-ref', text: 'private-body', identityClaims: [
    { key: 'private-key', owner: 'primary', locator: 'https://example.test/private-url', provenance: 'private-provenance' },
  ] })], { scope: 'private-scope' });
  const result = evaluate(current);
  assert.equal(result.candidates[0].identity.key, 'private-key');
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /private|example\.test/);
  assert.doesNotMatch(JSON.stringify(evaluate({ ...current, access: 'private-error' })), /private/);
});

test('one deterministic build yields matching Node and standalone browser entry points', async () => {
  const source = await readFile(new URL('../src/core.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require|globalThis|window|document|chrome|fetch|process|Date)\b/);
  const manifest = await buildSharedDOMEngine();
  assert.deepEqual(await buildSharedDOMEngine(), manifest);
  const persisted = JSON.parse(await readFile(new URL('../dist/artifact-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(persisted, manifest);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  const node = await import('../dist/core.mjs');
  const browser = vm.createContext({});
  const packagedBrowser = await readFile(new URL('../browser-runtime.js', import.meta.url));
  assert.equal(createHash('sha256').update(packagedBrowser).digest('hex'), manifest.artifacts['browser-runtime.js'].sha256);
  vm.runInContext(packagedBrowser.toString('utf8'), browser);
  const input = { schemaVersion: SCHEMA_VERSION, policy, current: sample([entry()]) };
  assert.deepEqual(node.assessDOM(input), assessDOM(input));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.AkuSharedDOMEngine.assessDOM(input))), assessDOM(input));
});
