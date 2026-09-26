import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const compactText = (v) => String(v || "").replace(/\s+/g," ").trim();
const helpers={compactText,structuredText:(v)=>v?.innerText||"",normalizeHttpUrl:(v)=>v||null};
function adapter(source,document,extra={}){
 const ctx=vm.createContext({URL,document,window:{document,location:{hostname:source==="x"?"x.com":"www.linkedin.com",pathname:"/feed/"}},...extra});ctx.globalThis=ctx;
 for(const file of ["source-adapter-runtime.js",`adapters/${source}-adapter.js`])vm.runInContext(fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8"),ctx);
 return ctx.AkuSourceAdapters.get(source);
}
function post(id,text="Post text",markers=[]){
 const time={closest:()=>({href:`https://x.com/a/status/${id}`})};
 return {innerText:`Author\n${text}`,querySelector:(s)=>s.includes('tweetText')?{innerText:text}:s.includes('User-Name')?{innerText:"Author"}:null,
 querySelectorAll:(s)=>s==="time"?[time]:s.includes('replyingTo')?markers:[],};
}
test("X reply and media-only quote remain independent and parent comes from exact passive ID",()=>{
 const child=post("12345"),parent=post("67890","Visible parent");
 const a=adapter("x",{querySelectorAll:()=>[child,parent]},{AkuXMediaEvidenceRuntime:{lookupReplyTo:()=>"67890"}});
 const relations=a.extractDirectContext(child,{...helpers,permalink:"https://x.com/a/status/12345",quotedPost:{permalink:"https://x.com/q/status/99999",text:"",media:[{kind:"image"}]}});
 assert.deepEqual(Array.from(relations,r=>r.kind),["quotes","replies_to"]);assert.equal(relations[0].target.hasMedia,true);assert.equal(relations[1].target.text,"Visible parent");
});
test("X does not infer reply from post text, own link, or ambiguous marker links",()=>{
 const child=post("12345","Replying to somebody in the body");const a=adapter("x",{querySelectorAll:()=>[]});
 assert.equal(a.extractDirectContext(child,{...helpers,permalink:"https://x.com/a/status/12345"}).length,0);
 const marker={innerText:"Membalas @someone",closest:()=>null,querySelectorAll:()=>[{href:"https://x.com/a/status/12345"},{href:"https://x.com/b/status/67890"},{href:"https://x.com/c/status/99999"}]};
 const result=a.extractDirectContext(post("12345","Body",[marker]),{...helpers,permalink:"https://x.com/a/status/12345"});
 assert.equal(result[0].target.permalink,"");assert.equal(result[0].target.availability,"reference_only");
 const self=a.extractDirectContext(child,{...helpers,permalink:"https://x.com/a/status/12345",quotedPost:{permalink:"https://x.com/i/status/12345",text:"self"}});assert.equal(self.length,0);
});
function linkedIn(label="Alice commented",comments=[]){
 const actor={innerText:"Alice",href:"https://www.linkedin.com/in/alice"};const header={innerText:label,querySelectorAll:()=>[actor]};
 const container={innerText:`${label}\nOwner\nBody`,querySelector:(s)=>s.includes('actor')?{innerText:"Owner"}:null,querySelectorAll:(s)=>s.includes('header__text')?[header]:s.includes('comments-comment-item')?comments:[],};
 return container;
}
function comment(author="alice",parent=null,text="Comment evidence"){
 const node={getAttribute:()=>"urn:li:comment:123",parentElement:{closest:()=>parent},getClientRects:()=>[{}]};
 const actor={href:`https://www.linkedin.com/in/${author}`,innerText:author,closest:(s)=>s.includes("comments-comment")?node:null};
 const body={innerText:text,closest:()=>node};node.querySelectorAll=(s)=>s.includes('name-text')?[actor]:[body];return node;
}
test("LinkedIn banner-only and unrelated or multiple actor comments never invent body",()=>{
 const a=adapter("linkedin",{});
 for(const comments of [[],[comment("bob")],[comment(),comment()]]){
  const relations=a.extractDirectContext(linkedIn("Alice commented",comments),helpers);assert.equal(relations.length,1);assert.equal(relations[0].target.availability,"reference_only");assert.equal(relations[0].target.text,undefined);
 }
 const one=a.extractDirectContext(linkedIn("Alice commented",[comment()]),helpers);assert.equal(one[0].target.text,"Comment evidence");
});
test("LinkedIn reply requires actual nested parent; phrase in post body is not a relation",()=>{
 const a=adapter("linkedin",{});const parent=comment("bob",null,"Parent comment"),reply=comment("alice",parent,"Reply evidence");
 const relations=a.extractDirectContext(linkedIn("Alice replied to Bob",[parent,reply]),helpers);assert.equal(relations[0].parent.text,"Parent comment");assert.equal(relations[0].target.text,"Reply evidence");
 const collapsed=a.extractDirectContext(linkedIn("Alice replied to Bob",[comment()]),helpers);assert.equal(collapsed[0].target.availability,"reference_only");assert.equal(collapsed[0].parent,undefined);
 const body=linkedIn("Nothing",[]);body.innerText="Owner\nAlice replied to Bob";assert.equal(a.extractDirectContext(body,helpers).length,0);
 assert.equal(a.extractSemantics(body,helpers).relationshipType,"original");
 const localized=a.extractDirectContext(linkedIn("Alice mengomentari",[]),helpers);assert.equal(localized[0].kind,"feed_comment");
});
