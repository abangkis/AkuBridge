import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const compactText = (v) => String(v || "").replace(/\s+/g," ").trim();
const helpers={compactText,structuredText:(v)=>v?.innerText||"",normalizeHttpUrl:(v)=>v||null};
function adapter(source,document,extra={}){
 const ctx=vm.createContext({URL,document,window:{document,location:{hostname:source==="x"?"x.com":"www.linkedin.com",pathname:"/feed/"}},...extra});ctx.globalThis=ctx;
 for(const file of ["capture-primitives.js","source-adapter-runtime.js",`adapters/${source}-adapter.js`])vm.runInContext(fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8"),ctx);
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
function linkedInSdui({banner="Ayu Pratama commented",text="Synthetic comment line.\nSecond line.",commentAuthors=["ayu"],bodyMention="",bannerLinkName="Ayu Pratama",bannerLinkUrls=["ayu"],bodyCount=1,nestedMenu=false,nestedBody=false,rootMarker="id"}={}){
 const rootSelector=`[${rootMarker}^="replaceableComment_urn:li:comment:"]`;
 const rootID="replaceableComment_urn:li:comment:(activity:1234567890123456789,9876543210987654321)";
 const root={id:rootMarker==="id"?rootID:"",
  getAttribute:(name)=>name===rootMarker?rootID:null,
  getClientRects:()=>[{}],parentElement:null,querySelectorAll:null};
 const body={innerText:text, parentElement:root, contains:(node)=>{
  for(let current=node;current;current=current.parentElement)if(current===body)return true;return false;
 }};
 const bodies=Array.from({length:bodyCount},(_,index)=>index===0?body:{innerText:"Additional body evidence.",parentElement:root,contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}});
 body.closest=(selector)=>selector.includes("expandable-text-box")?body:selector.includes(rootSelector)?root:null;
 for(const candidate of bodies)candidate.closest=body.closest;
 if(nestedBody){
  const outer={innerText:text,parentElement:root,contains:(node)=>node===body||body.contains(node),closest:body.closest};
  body.parentElement=outer;bodies.splice(0,bodies.length,outer,body);
 }
 const profileLinks=commentAuthors.map((author,index)=>({href:`https://www.linkedin.com/in/${author}`,innerText:index===0?"Ayu Pratama Verified Profile 1st\nAyu Pratama • 1st\nSynthetic Engineer":"Ayu Pratama",parentElement:root,closest:(selector)=>selector.includes(rootSelector)?root:null}));
 const mention=bodyMention?{href:`https://www.linkedin.com/in/${bodyMention}`,innerText:bodyMention,parentElement:body,closest:(selector)=>selector.includes(rootSelector)?root:null}:null;
 const options={getAttribute:()=>"View more options for Ayu Pratama’s comment.",parentElement:root,closest:(selector)=>selector.includes(rootSelector)?root:null};
 const nestedRoot={id:"replaceableComment_urn:li:comment:(activity:1234567890123456789,1111111111111111111)",closest:()=>null};
 const nestedOptions={getAttribute:()=>"View more options for Nested Person’s comment.",parentElement:nestedRoot,closest:(selector)=>selector.includes(rootSelector)?nestedRoot:null};
 root.querySelectorAll=(selector)=>{
  if(selector.includes("expandable-text-box"))return bodies;
  if(selector.includes('a[href*="/in/"]'))return [...profileLinks,...(mention?[mention]:[])];
  if(selector.includes("button[aria-label]"))return nestedMenu?[nestedOptions,options]:[options];
  return [];
 };
 root.contains=(node)=>{for(let current=node;current;current=current.parentElement)if(current===root)return true;return false;};
 const bannerActors=bannerLinkUrls.map((slug)=>({href:`https://www.linkedin.com/in/${slug}`,innerText:bannerLinkName,parentElement:null,closest:()=>null}));
 const bannerActor=bannerActors[0];
 const bannerNode={innerText:banner,parentElement:null,querySelectorAll:(selector)=>selector.includes('a[href*="/in/"]')?bannerActors:[]};
 for(const candidate of bannerActors)candidate.parentElement=bannerNode;
 const postAuthor={getAttribute:()=>"Open control menu for post by Post Owner",parentElement:null,closest:()=>null};
 const container={innerText:`${banner}\nPost Owner\nPost body`,querySelector:()=>null,querySelectorAll:(selector)=>{
  if(selector.includes("button[aria-label]"))return [postAuthor];
  if(selector.includes("header__text-view")||selector.includes('data-view-name="feed-social-context"'))return [];
  if(selector.includes('a[href*="/in/"]'))return bannerActors;
  if(selector.includes(rootSelector))return [root];
  return [];
 }};
 return {container,root,body,bannerNode,bannerActor};
}
test("LinkedIn banner-only and unrelated or multiple actor comments never invent body",()=>{
 const a=adapter("linkedin",{});
 for(const comments of [[],[comment("bob")],[comment(),comment()]]){
  const relations=a.extractDirectContext(linkedIn("Alice commented",comments),helpers);assert.equal(relations.length,1);assert.equal(relations[0].target.availability,"reference_only");assert.equal(relations[0].target.text,undefined);
 }
 const one=a.extractDirectContext(linkedIn("Alice commented",[comment()]),helpers);assert.equal(one[0].target.text,"Comment evidence");
});
for(const rootMarker of ["id","componentkey"]){
test(`LinkedIn SDUI ${rootMarker} root and screenreader author text are captured conservatively`,()=>{
 const a=adapter("linkedin",{}), fixture=linkedInSdui({nestedMenu:true,rootMarker});
 const [relation]=a.extractDirectContext(fixture.container,helpers);
 assert.equal(relation.actorUrl,"https://www.linkedin.com/in/ayu");
 assert.equal(relation.target.id,"urn:li:comment:(activity:1234567890123456789,9876543210987654321)");
 assert.equal(relation.target.author,"Ayu Pratama");
 assert.equal(relation.target.text,"Synthetic comment line.\nSecond line.");
 assert.equal(relation.target.availability,"captured");
 const nestedBody=linkedInSdui({nestedBody:true});
 assert.equal(a.extractDirectContext(nestedBody.container,helpers)[0].target.availability,"captured");
});
}
test("LinkedIn SDUI ignores body mentions and keeps missing, ambiguous, and hidden comments reference-only",()=>{
 const a=adapter("linkedin",{});
 const mention=linkedInSdui({bodyMention:"other-person"});
 const [mentionRelation]=a.extractDirectContext(mention.container,helpers);
 assert.equal(mentionRelation.target.author,"Ayu Pratama");
 const ambiguous=linkedInSdui({commentAuthors:["ayu","other-person"]});
 assert.equal(a.extractDirectContext(ambiguous.container,helpers)[0].target.availability,"reference_only");
 const hidden=linkedInSdui();hidden.root.getClientRects=()=>[];
 assert.equal(a.extractDirectContext(hidden.container,helpers)[0].target.availability,"reference_only");
 const missing=linkedInSdui({commentAuthors:[]});
 assert.equal(a.extractDirectContext(missing.container,helpers)[0].target.availability,"reference_only");
 const prefixCollision=linkedInSdui({bannerLinkName:"Ayu PratamaX"});
 assert.equal(a.extractDirectContext(prefixCollision.container,helpers)[0].actorUrl,"");
 const shortenedName=linkedInSdui({bannerLinkName:"Ayu"});
 assert.equal(a.extractDirectContext(shortenedName.container,helpers)[0].actorUrl,"");
 const conflictingBannerActors=linkedInSdui({bannerLinkUrls:["ayu","ayu-second"]});
 assert.equal(a.extractDirectContext(conflictingBannerActors.container,helpers)[0].actorUrl,"");
 const multipleBodies=linkedInSdui({bodyCount:2});
 assert.equal(a.extractDirectContext(multipleBodies.container,helpers)[0].target.availability,"reference_only");
 const whitespace=linkedInSdui({text:" \n \t "});
 assert.equal(a.extractDirectContext(whitespace.container,helpers)[0].target.availability,"reference_only");
 const truncated=linkedInSdui({text:"x".repeat(4100)});
 const truncatedTarget=a.extractDirectContext(truncated.container,helpers)[0].target;
 assert.equal(truncatedTarget.text.length,4000);assert.equal(truncatedTarget.availability,"partial");
});
test("LinkedIn reply requires actual nested parent; phrase in post body is not a relation",()=>{
 const a=adapter("linkedin",{});const parent=comment("bob",null,"Parent comment"),reply=comment("alice",parent,"Reply evidence");
 const relations=a.extractDirectContext(linkedIn("Alice replied to Bob",[parent,reply]),helpers);assert.equal(relations[0].parent.text,"Parent comment");assert.equal(relations[0].target.text,"Reply evidence");
 const collapsed=a.extractDirectContext(linkedIn("Alice replied to Bob",[comment()]),helpers);assert.equal(collapsed[0].target.availability,"reference_only");assert.equal(collapsed[0].parent,undefined);
 const body=linkedIn("Nothing",[]);body.innerText="Owner\nAlice replied to Bob";assert.equal(a.extractDirectContext(body,helpers).length,0);
 assert.equal(a.extractSemantics(body,helpers).relationshipType,"original");
 const localized=a.extractDirectContext(linkedIn("Alice mengomentari",[]),helpers);assert.equal(localized[0].kind,"feed_comment");
});
