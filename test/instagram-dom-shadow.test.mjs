import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {registeredScriptsForSources,INSTAGRAM_DOM_SHADOW_SCRIPTS} from '../source-access-policy.js';
import {sourceRuntimeScripts,sourceDefinition} from '../source-catalog.js';

const engine=await readFile(new URL('../shared-dom-engine/browser-runtime.js',import.meta.url),'utf8');
const probe=await readFile(new URL('../adapters/instagram-dom-shadow.js',import.meta.url),'utf8');
function runtime(host='https://www.instagram.com/',failed=false){
  const context=vm.createContext({URL,window:{location:new URL(host)},document:{body:{innerText:'Private raw text'},querySelector:()=>null}});
  vm.runInContext(engine,context);
  if(failed)context.AkuSharedDOMEngine={SCHEMA_VERSION:1,assessDOM(){throw Error('Private raw identity');}};
  vm.runInContext(probe,context);return context.AkuInstagramDOMShadow;
}
test('Instagram registration carries the shared engine and source probe without adding source authority',()=>{
  const entries=registeredScriptsForSources(['instagram']);assert.equal(entries.length,1);
  assert.deepEqual(entries[0].matches,['https://www.instagram.com/*','https://instagram.com/*']);
  for(const file of INSTAGRAM_DOM_SHADOW_SCRIPTS)assert.ok(entries[0].js.includes(file));
  assert.deepEqual(sourceDefinition('instagram').supportScripts,INSTAGRAM_DOM_SHADOW_SCRIPTS);
  const all=sourceRuntimeScripts();assert.equal(all.length,new Set(all).size);
  assert.ok(registeredScriptsForSources(['x']).some(entry=>entry.js.includes('adapters/x-dom-shadow.js')));
  for(const source of ['linkedin','facebook'])assert.equal(registeredScriptsForSources([source]).some(entry=>entry.js.includes('adapters/instagram-dom-shadow.js')),false);
});
test('Instagram shadow keeps access and unknown-empty diagnostics observational',()=>{
  const shadow=runtime(),sample={adapter:{source:'instagram'},candidates:[],visible:()=>{throw Error('must not inspect blocked candidates');},loading:false,feedRoot:true};
  assert.equal(shadow.assess(sample).code,'empty_unverified');
  for(const access of ['login_required','unavailable','challenge_required'])assert.equal(shadow.assess({...sample,access,loading:true}).code,access);
  assert.equal(runtime('https://evil.test/').assess(sample).code,'wrong_route');
  assert.equal(shadow.resolveIdentity,undefined,'shadow cannot replace capture identity');
});
test('Instagram probe failure exposes closed codes and counts without raw data',()=>{
  const result=runtime(undefined,true).assess({adapter:{source:'instagram'},candidates:[],visible:()=>false});
  assert.equal(result.code,'probe_failed');assert.doesNotMatch(JSON.stringify(result),/Private/);
  assert.deepEqual(Object.keys(result).sort(),['code','counts','rejections']);
});
