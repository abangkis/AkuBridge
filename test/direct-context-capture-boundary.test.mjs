import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the production block extractor with unrelated browser/media services
// stubbed; this checks that optional context cannot discard independent evidence.
const source = fs.readFileSync(new URL('../content-script.js', import.meta.url), 'utf8');
const blockSource = source.slice(source.indexOf('  function extractBlock('), source.indexOf('  function normalizeQuotedPost('));
function extract(extractDirectContext) {
  const container = { innerText: 'Valid post body', querySelector: () => null, querySelectorAll: () => [] };
  const adapter = { extractText: node => node.innerText, extractSemantics: () => ({}), findAuthor: () => 'Post author', extractDirectContext };
  const context = vm.createContext({
    sourceAdapters: { get: () => adapter },
    structuredText: value => typeof value === 'string' ? value : value.innerText,
    compactText: value => String(value || '').trim(),
    normalizeHttpUrl: value => value || null, normalizeHttpsUrl: value => value || null,
    findPermalinkDetails: () => ({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/' }),
    normalizeDate: () => null, normalizeQuotedPost: () => null, legacyExpansionState: () => 'unknown',
    capturePrimitives: { textCompleteness: () => 'unknown' }, findContentRoot: () => container,
    findMedia: () => [{ kind: 'image', url: 'https://media.licdn.com/synthetic.jpg' }],
    findAvatar: () => null, findPlatformId: () => 'linkedin:activity:1234567890123456789',
  });
  vm.runInContext(blockSource, context);
  return context.extractBlock(container, 'linkedin', 4000, null);
}

test('windowed capture preserves post identity, body and media when optional context throws or is malformed', () => {
  for (const extractor of [() => { throw Error('private DOM failure detail'); }, () => ({ unexpected: true })]) {
    const block = extract(extractor);
    assert.equal(block.text, 'Valid post body');
    assert.equal(block.author, 'Post author');
    assert.equal(block.platformId, 'linkedin:activity:1234567890123456789');
    assert.equal(block.media.length, 1);
    assert.equal(block.directContext.length, 0);
    assert.equal(block.presentation.directContextStatus, 'extraction_failed');
    assert.ok(!JSON.stringify(block).includes('private DOM failure detail'));
  }
});

test('windowed capture keeps independently extracted comment bodies', () => {
  const relation = { kind: 'feed_comment', target: { kind: 'comment', text: 'Valid comment', availability: 'captured' } };
  const block = extract(() => [relation]);
  assert.equal(block.directContext.length, 1);
  assert.equal(block.directContext[0].target.text, 'Valid comment');
  assert.equal(block.presentation.directContextStatus, undefined);
});

test('windowed controller finalizes exact reply owners after capture without deferred media', async () => {
  const block = id => ({platformId: 'x:status:' + id, permalink: 'https://x.com/owner/status/' + id,
    text: 'Body', relationshipType: 'original', directContext: []});
  const child = '12345', parent = '67890', throwing = '33445', duplicate = '11223';
  const conflictingOwner = {...block('21212'), presentation: {primaryIdentity: {
    status: 'conflicting', permalink: null}}};
  const mismatched = {...block('31313'), permalink: 'https://x.com/owner/status/91919'};
  const viewportBlocks = [
    [block(child), block(throwing), block(duplicate), block(duplicate), conflictingOwner, mismatched],
    [block(child), block(throwing)],
  ];
  const reads = [];
  let scrollY = 0, next = 0, restored = false;
  const passive = {lookupReplyTo(candidate) {
    reads.push(candidate);
    assert.ok(restored, 'reply arrived only after the last viewport was captured');
    if (candidate.endsWith(throwing)) throw new Error('optional cache unavailable');
    return parent;
  }};
  const adapter = {version: 'fixture', structuredMediaEvidence: {runtime: () => passive}};
  const context = vm.createContext({
    URL, performance, CAPTURE_DEADLINE_RESERVE_MS: 100,
    sourceMatchesPage: () => true, assertNoXAccessChallenge: () => {},
    sourceAdapters: {get: () => adapter, capabilities: () => ({})},
    capturePolicy: {
      normalizeCapturePlan: () => ({scrolls: 1, scrollFraction: 1, scrollSettleMs: 0, captureTimeoutMs: 10000, restoreScroll: true}),
      countNewCandidates(blocks, seen) { const before = seen.size; for (const value of blocks) seen.add(value.platformId); return seen.size - before; },
    },
    captureVisibleSnapshot: async () => ({blocks: viewportBlocks[next++]}),
    updateCaptureProgress: () => {}, getScrollContext: () => ({}), readScrollPosition: () => ({x: 0, y: scrollY}),
    viewportHeight: () => 500, scrollByContext: (_, delta) => {scrollY += delta;}, delay: async () => {},
    restoreScrollContext: async () => {scrollY = 0; restored = true; return true;},
    summarizeFieldCoverage: () => ({}), qualityPolicy: {summarize: () => ({})},
    mediaAcquisitionEngine: {summarize: () => ({outcomes: {recovered: 0}})}, blockIdentity: value => value.platformId,
    window: {location: new URL('https://x.com/home')}, document: {title: ''},
    sourceEvents: () => [], describeScrollContext: () => 'window',
  });
  vm.runInContext(fs.readFileSync(new URL('../capture-primitives.js', import.meta.url), 'utf8'), context);
  context.capturePrimitives = context.AkuCapturePrimitives;
  vm.runInContext(source.slice(source.indexOf('  async function collectBoundedObservation('),
    source.indexOf('  async function hydratePersistentAvatarEvidence(')), context);
  const output = await context.collectBoundedObservation({source: 'x', sourceFreshness: {}});
  assert.equal(output.coverage.structuredMediaEvidence.deferred.requested, false);
  assert.deepEqual(reads, ['x:status:' + child, 'x:status:' + throwing]);
  for (const {blocks} of output.snapshots) {
    assert.equal(blocks[0].relationshipType, 'reply');
    assert.equal(blocks[0].parentPermalink, 'https://x.com/i/status/' + parent);
    assert.equal(blocks[0].directContext.length, 1);
    assert.equal(blocks[0].directContext[0].target.id, parent);
    assert.equal(blocks[0].directContext[0].provenance, 'observed_response');
    assert.ok(blocks.slice(1).every(value => value.directContext.length === 0 && value.text === 'Body'));
  }
});
