import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const runtimeSource=readFileSync(new URL('../source-freshness-runtime.js',import.meta.url),'utf8');
const xAdapterSource=readFileSync(new URL('../adapters/x-adapter.js',import.meta.url),'utf8');
function fixture({
  inside = false, url = 'https://x.com/home', feedURL = 'https://x.com/home',
  source = 'x', enabled = true, connected = true, onDiscover = () => {},
  label = 'Show 12 posts', supported = true, visible = true, composer = false,
  changesFeed = false,
} = {}) {
  const clickedLabels = [];
  let now = Date.now();
  class Clock extends Date {
    static now() { return now; }
  }
  class Element {
    constructor(text, { isVisible = true, isConnected = true } = {}) {
      this.innerText = text;
      this.isVisible = isVisible;
      this.isConnected = isConnected;
    }
    getBoundingClientRect() {
      return { width: 100, height: this.isVisible ? 25 : 0, bottom: 25, top: 0, right: 100, left: 0 };
    }
    click() {
      clickedLabels.push(this.innerText);
      if (this === button && changesFeed) candidate.innerText = 'Newly visible feed post';
    }
  }
  const button = new Element(label, { isVisible: visible, isConnected: connected });
  const candidate = new Element('Original feed post');
  candidate.contains = element => inside && element === button;
  const controls = composer ? [new Element('New Post'), button] : [button];
  const location = new URL(url);
  let xAdapter;
  const context = vm.createContext({
    Element, URL, Date: Clock, location,
    window: { location, innerHeight: 900, innerWidth: 1280, scrollY: 0 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { querySelectorAll: () => controls },
    setTimeout: (callback, milliseconds) => { now += milliseconds; callback(); },
    AkuCapturePrimitives: {},
    AkuSourceAdapters: {
      register: adapter => { xAdapter = adapter; },
      get: () => ({
        matchesPage: () => location.origin === new URL(feedURL).origin,
        freshness: {
          ...xAdapter.freshness,
          revealSupported: supported,
          headless: { enabled, matchesFeedURL: value => value === feedURL },
        },
        discoverCandidates: () => {
          onDiscover(location);
          return { candidates: [candidate] };
        },
      }),
    },
  });
  vm.runInContext(xAdapterSource, context);
  vm.runInContext(runtimeSource, context);
  const runtime = context.AkuSourceFreshnessRuntime;
  return {
    activate: options => runtime.activatePending(source, { expectedPageUrl: url, deadlineAt: now + 1000, ...options }),
    probe: () => runtime.probe(source),
    reveal: () => runtime.reveal(source),
    clicks: () => clickedLabels.length,
    clickedLabels,
  };
}
test('activates one connected visible feed control',()=>{
  const f=fixture();assert.equal(f.activate().activated,true);assert.equal(f.clicks(),1);
});

test('X does not treat the New Post composer as pending feed content', async () => {
  const f = fixture({ label: 'New Post' });
  assert.equal(f.probe().pendingContentDetected, false);
  assert.throws(() => f.activate(), /freshness_control_unavailable/);
  await assert.rejects(f.reveal(), /pending new-content control was no longer available/);
  assert.deepEqual(f.clickedLabels, []);
});

test('X skips the composer and still activates supported feed controls', () => {
  for (const label of ['New posts', 'Show posts', 'Show 1 post', 'Show 12 posts']) {
    const f = fixture({ composer: true, label });
    assert.equal(f.probe().pendingContentLabel, label);
    assert.equal(f.activate().label, label);
    assert.deepEqual(f.clickedLabels, [label]);
  }
});

test('Windowed X reveal requires a changed visible feed after clicking the feed control', async () => {
  const unchanged = fixture({ composer: true });
  await assert.rejects(unchanged.reveal(), /did not reveal a changed, visible feed/);
  assert.deepEqual(unchanged.clickedLabels, ['Show 12 posts']);

  const changed = fixture({ composer: true, changesFeed: true });
  const result = await changed.reveal();
  assert.equal(result.evidence, 'feed_fingerprint_changed');
  assert.equal(result.label, 'Show 12 posts');
  assert.deepEqual(changed.clickedLabels, ['Show 12 posts']);
});
test('does not activate matching labels inside a post or quote, hidden, or stale controls',()=>{
  for(const options of [{inside:true},{visible:false},{connected:false},{label:'Like'}]){
    const f=fixture(options);assert.throws(()=>f.activate(),/freshness_control_unavailable/);assert.equal(f.clicks(),0);
  }
});
test('rejects expiry, explicit posts, wrong routes, and route changes during discovery',()=>{
  for(const options of [{url:'https://x.com/user/status/12345'},{url:'https://evil.example/home'},
    {onDiscover:location=>{location.href='https://x.com/login';}}]){
    const f=fixture(options);assert.throws(()=>f.activate(),/freshness_route_changed/);assert.equal(f.clicks(),0);
  }
  const expired=fixture();assert.throws(()=>expired.activate({deadlineAt:Date.now()-1}),/freshness_deadline/);assert.equal(expired.clicks(),0);
});
test('rejects missing deadline and unsupported reveal',()=>{
  assert.throws(()=>fixture().activate({deadlineAt:undefined}),/freshness_deadline/);
  const f=fixture({supported:false});assert.throws(()=>f.activate(),/freshness_reveal_unsupported/);assert.equal(f.clicks(),0);
});

test('activation follows adapter route policy without a source-specific host branch',()=>{
  const url='https://www.linkedin.com/feed/';
  const f=fixture({source:'linkedin',url,feedURL:url});
  assert.equal(f.activate().activated,true);assert.equal(f.clicks(),1);
  const disabled=fixture({source:'linkedin',url,feedURL:url,enabled:false});
  assert.throws(()=>disabled.activate(),/freshness_reveal_unsupported/);assert.equal(disabled.clicks(),0);
});
