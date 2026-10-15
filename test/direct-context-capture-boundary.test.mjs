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
