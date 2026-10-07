import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const runtimeSource=readFileSync(new URL('../source-freshness-runtime.js',import.meta.url),'utf8');
function fixture({inside=false,url='https://x.com/home',feedURL='https://x.com/home',source='x',enabled=true,connected=true,onDiscover=()=>{},label='Show 12 posts',supported=true,visible=true}={}){
  let clicks=0;
  class Element {
    constructor(){this.innerText=label;this.textContent=label;this.isConnected=connected;}
    getBoundingClientRect(){return {width:100,height:visible?25:0,bottom:25,top:0,right:100,left:0};}
    click(){clicks++;}
  }
  const button=new Element();
  const candidate={contains:e=>inside&&e===button};
  const location={href:url};
  const adapter={matchesPage:()=>new URL(location.href).origin===new URL(feedURL).origin,freshness:{revealSupported:supported,
    headless:{enabled,matchesFeedURL:value=>value===feedURL},
    rejectInsideFeedCandidate:true,pendingContentPattern:/^(?:new posts?|show(?: \d+)? posts?)$/i},
    discoverCandidates:()=>{onDiscover(location);return {candidates:[candidate]};}};
  const context=vm.createContext({Element,URL,Date,location,window:{innerHeight:900,innerWidth:1280},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    document:{querySelectorAll:()=>[button]},AkuSourceAdapters:{get:()=>adapter}});
  vm.runInContext(runtimeSource,context);
  return {activate:options=>context.AkuSourceFreshnessRuntime.activatePending(source,{expectedPageUrl:url,deadlineAt:Date.now()+1000,...options}),clicks:()=>clicks};
}
test('activates one connected visible feed control',()=>{
  const f=fixture();assert.equal(f.activate().activated,true);assert.equal(f.clicks(),1);
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
