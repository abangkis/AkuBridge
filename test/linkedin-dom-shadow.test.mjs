import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {registeredScriptsForSources,LINKEDIN_DOM_SHADOW_SCRIPTS} from '../source-access-policy.js';
import {sourceDefinition,sourceRuntimeScripts} from '../source-catalog.js';

const engine=await readFile(new URL('../shared-dom-engine/browser-runtime.js',import.meta.url),'utf8');
const permalinkPolicy=await readFile(new URL('../linkedin-permalink-policy.js',import.meta.url),'utf8');
const probe=await readFile(new URL('../adapters/linkedin-dom-shadow.js',import.meta.url),'utf8');
function runtime(host='https://www.linkedin.com/feed/',failed=false){
  const context=vm.createContext({URL,window:{location:new URL(host)},document:{body:{innerText:'Private text'},querySelector:()=>null}});
  vm.runInContext(engine,context);
  vm.runInContext(permalinkPolicy,context);
  if(failed)context.AkuSharedDOMEngine={SCHEMA_VERSION:1,assessDOM(){throw Error('Private source evidence');}};
  vm.runInContext(probe,context);return context.AkuLinkedInDOMShadow;
}
test('LinkedIn shadow registration shares the engine without changing permissions or capture ownership',()=>{
  const entries=registeredScriptsForSources(['linkedin']);assert.equal(entries.length,1);
  assert.deepEqual(entries[0].matches,['https://www.linkedin.com/feed/*','https://www.linkedin.com/posts/*']);
  for(const file of LINKEDIN_DOM_SHADOW_SCRIPTS)assert.ok(entries[0].js.includes(file));
  assert.deepEqual(sourceDefinition('linkedin').supportScripts,['linkedin-permalink-policy.js','linkedin-timestamp-policy.js','diagnostics/linkedin-recovery.js','anchor-geometry.js',...LINKEDIN_DOM_SHADOW_SCRIPTS]);
  const scripts=sourceRuntimeScripts();assert.equal(scripts.length,new Set(scripts).size);
  for(const source of ['x','facebook','instagram'])assert.equal(registeredScriptsForSources([source]).some(e=>e.js.includes('adapters/linkedin-dom-shadow.js')),false);
});
test('LinkedIn shadow preserves blocked access and honest unknown-empty state',()=>{
  const shadow=runtime(),sample={adapter:{source:'linkedin'},candidates:[],visible:()=>{throw Error('blocked');},feedRoot:true};
  assert.equal(shadow.assess(sample).code,'empty_unverified');
  for(const access of ['login_required','challenge_required','unavailable','navigation_failed'])assert.equal(shadow.assess({...sample,access,loading:true}).code,access);
  assert.equal(runtime('https://foreign.test/').assess(sample).code,'wrong_route');
  assert.equal(shadow.resolveIdentity,undefined);
});
test('LinkedIn shadow failure never exposes raw source data',()=>{
  const value=runtime(undefined,true).assess({adapter:{source:'linkedin'},candidates:[],visible:()=>false});
  assert.equal(value.code,'probe_failed');assert.doesNotMatch(JSON.stringify(value),/Private/);
  assert.deepEqual(Object.keys(value).sort(),['code','counts','rejections']);
});
