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
function linkedInSdui({banner="Ayu Pratama commented",text="Synthetic comment line.\nSecond line.",commentAuthors=["ayu"],bodyMention="",bannerLinkName="Ayu Pratama",bannerLinkUrls=["ayu"],bodyCount=1,extraBodyTexts=[],commentName="Ayu Pratama",nestedMenu=false,nestedBody=false,rootMarker="id"}={}){
 const rootSelector=`[${rootMarker}^="replaceableComment_urn:li:comment:"]`;
 const rootID="replaceableComment_urn:li:comment:(activity:1234567890123456789,9876543210987654321)";
 const root={id:rootMarker==="id"?rootID:"",
  getAttribute:(name)=>name===rootMarker?rootID:null,
  getClientRects:()=>[{}],parentElement:null,querySelectorAll:null};
 const body={innerText:text, parentElement:root, contains:(node)=>{
  for(let current=node;current;current=current.parentElement)if(current===body)return true;return false;
 }};
 const bodies=Array.from({length:bodyCount},(_,index)=>index===0?body:{innerText:extraBodyTexts[index-1]??"Additional body evidence.",parentElement:root,contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}});
 body.closest=(selector)=>selector.includes("expandable-text-box")?body:selector.includes(rootSelector)?root:null;
 for(const candidate of bodies)candidate.closest=body.closest;
 if(nestedBody){
  const outer={innerText:text,parentElement:root,contains:(node)=>node===body||body.contains(node),closest:body.closest};
  body.parentElement=outer;bodies.splice(0,bodies.length,outer,body);
 }
 const profileLinks=commentAuthors.map((author,index)=>({href:`https://www.linkedin.com/in/${author}`,innerText:index===0?"Ayu Pratama Verified Profile 1st\nAyu Pratama • 1st\nSynthetic Engineer":"Ayu Pratama",parentElement:root,closest:(selector)=>selector.includes(rootSelector)?root:null}));
 const mention=bodyMention?{href:`https://www.linkedin.com/in/${bodyMention}`,innerText:bodyMention,parentElement:body,closest:(selector)=>selector.includes(rootSelector)?root:null}:null;
 const options={getAttribute:()=>`View more options for ${commentName}’s comment.`,parentElement:root,closest:(selector)=>selector.includes(rootSelector)?root:null};
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
function linkedInSduiComments(comments,{banner="Ayu Pratama commented",bannerLinkName="Ayu Pratama",bannerLinkUrls=["ayu"]}={}){
 const fixtures=comments.map((spec)=>linkedInSdui({
  banner,text:spec.text??"Synthetic comment line.",commentAuthors:spec.commentAuthors??[spec.authorSlug??"ayu"],
  bannerLinkName,bannerLinkUrls,bodyCount:spec.bodyCount??1,rootMarker:spec.rootMarker??"id",
  extraBodyTexts:spec.extraBodyTexts??[],commentName:spec.commentName??"Ayu Pratama",
  nestedMenu:spec.nestedMenu??false,nestedBody:spec.nestedBody??false,
 }));
 const roots=fixtures.map((fixture,index)=>{
  const root=fixture.root,spec=comments[index];
  if(Object.hasOwn(spec,"id"))root.id=spec.id??"";
  if(spec.hidden)root.getClientRects=()=>[];
  if(spec.bodyHidden)fixture.body.getClientRects=()=>[];
  root.parentElement={closest:(selector)=>spec.parentIndex==null?null:selector.includes("comments-comment-item")?fixtures[spec.parentIndex]?.root??null:null};
  return root;
 });
 const base=linkedInSdui({banner,bannerLinkName,bannerLinkUrls});
 const container={...base.container,querySelectorAll:(selector)=>{
  if(selector.includes("comments-comment-item")||selector.includes("comments-comment-entity"))return roots;
  return base.container.querySelectorAll(selector);
 }};
 return {container,roots,fixtures};
}
test("LinkedIn banner-only and unrelated or multiple actor comments never invent body",()=>{
 const a=adapter("linkedin",{});
 for(const comments of [[],[comment("bob")]]){
  const relations=a.extractDirectContext(linkedIn("Alice commented",comments),helpers);assert.equal(relations.length,1);assert.equal(relations[0].target.availability,"reference_only");assert.equal(relations[0].target.text,undefined);
 }
 const duplicate=a.extractDirectContext(linkedIn("Alice commented",[comment(),comment()]),helpers);
 assert.equal(duplicate.length,1);assert.equal(duplicate[0].target.text,"Comment evidence");
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
test("LinkedIn returns every distinct actor-profile match and derives reply kind from DOM",()=>{
 const a=adapter("linkedin",{});
 const fixture=linkedInSduiComments([
  {id:"urn:li:comment:1111111111111111111",text:"Top-level comment."},
  {id:"urn:li:comment:2222222222222222222",text:"Nested reply.",parentIndex:0},
 ],{banner:"Ayu Pratama replied to Bob"});
 const relations=a.extractDirectContext(fixture.container,helpers);
 assert.equal(relations.length,2);
 assert.deepEqual(Array.from(relations,r=>r.kind),["feed_comment","feed_reply"]);
 assert.deepEqual(Array.from(relations,r=>r.matchBasis),["actor_profile","actor_profile"]);
 assert.deepEqual(Array.from(relations,r=>r.target.text),["Top-level comment.","Nested reply."]);
 assert.equal(relations[1].parent.text,"Top-level comment.");
 assert.equal(relations[0].observedText,"Ayu Pratama replied to Bob");
});
test("LinkedIn deduplicates exact copies, preserves unknown-ID distinct bodies, and marks conflicting IDs",()=>{
 const a=adapter("linkedin",{});
 const same=linkedInSduiComments([
  {id:"urn:li:comment:3333333333333333333",text:"Same evidence."},
  {id:"urn:li:comment:3333333333333333333",text:"Same evidence."},
 ]);
 assert.equal(a.extractDirectContext(same.container,helpers).length,1);
 const conflicting=linkedInSduiComments([
  {id:"urn:li:comment:4444444444444444444",text:"Evidence A."},
  {id:"urn:li:comment:4444444444444444444",text:"Evidence B."},
 ]);
 const [conflict]=a.extractDirectContext(conflicting.container,helpers);
 assert.equal(conflict.target.availability,"reference_only");
 assert.equal(conflict.target.captureReason,"comment_identity_ambiguous");
 assert.equal(conflict.target.text,undefined);
 const unknown=linkedInSduiComments([
  {id:null,text:"Unknown ID A."},
  {id:null,text:"Unknown ID B."},
 ]);
 const unknownRelations=a.extractDirectContext(unknown.container,helpers);
 assert.equal(unknownRelations.length,2);
 assert.deepEqual(Array.from(unknownRelations,r=>r.target.text),["Unknown ID A.","Unknown ID B."]);
 const mixed=linkedInSduiComments([
  {id:null,text:"Unknown first."},
  {id:"urn:li:comment:5555555555555555555",text:"Stable second."},
  {id:null,text:"Unknown third."},
 ]);
 assert.deepEqual(Array.from(a.extractDirectContext(mixed.container,helpers),r=>r.target.text),[
  "Unknown first.","Stable second.","Unknown third.",
 ]);
});
test("LinkedIn merges compatible stable-ID copies and keeps verified body evidence",()=>{
 const a=adapter("linkedin",{}),id="urn:li:comment:9999999999999999999";
 for(const comments of [
  [{id,text:""},{id,text:"Verified body.",commentName:"Ayu Pratama"}],
  [{id,text:"Verified body.",commentName:"Ayu"},{id,text:""}],
 ]){
  const [relation]=a.extractDirectContext(linkedInSduiComments(comments).container,helpers);
  assert.equal(relation.target.id,id);assert.equal(relation.target.text,"Verified body.");
  assert.equal(relation.target.availability,"captured");
 }
 const nameVariation=linkedInSduiComments([
  {id,text:"Same body.",commentName:"Ayu Pratama"},{id,text:"Same body.",commentName:"Ayu"},
 ]);
 assert.equal(a.extractDirectContext(nameVariation.container,helpers)[0].target.text,"Same body.");
 const emptyCandidate=linkedInSduiComments([
  {id,text:"Only positive body.",bodyCount:2,extraBodyTexts:[""]},
 ]);
 assert.equal(a.extractDirectContext(emptyCandidate.container,helpers)[0].target.text,"Only positive body.");
 const identicalCandidates=linkedInSdui({
  text:"Repeated body text.",bodyCount:2,extraBodyTexts:["Repeated   body\ntext."],
 });
 assert.equal(a.extractDirectContext(identicalCandidates.container,helpers)[0].target.text,"Repeated body text.");
 const ambiguousClone=linkedInSduiComments([
  {id,text:"Verified body."},{id,text:"Clone A.",bodyCount:2,extraBodyTexts:["Clone B."]},
 ]);
 assert.equal(a.extractDirectContext(ambiguousClone.container,helpers)[0].target.text,"Verified body.");
});
test("LinkedIn isolates comment read failures and reports unique failed roots",()=>{
 const a=adapter("linkedin",{}),fixture=linkedInSduiComments([
  {id:"urn:li:comment:1000000000000000001",text:"Bad query."},
  {id:"urn:li:comment:1000000000000000002",text:"Bad rectangles."},
  {id:"urn:li:comment:1000000000000000003",text:"Bad body helper."},
  {id:"urn:li:comment:1000000000000000004",text:"Valid sibling."},
 ]);
 fixture.roots[0].querySelectorAll=()=>{throw new Error("DO_NOT_LEAK_QUERY")};
 fixture.roots[1].getClientRects=()=>{throw new Error("DO_NOT_LEAK_RECTS")};
 fixture.fixtures[2].body.failRead=true;
 const [relation]=a.extractDirectContext(fixture.container,{
  ...helpers,structuredText:(body)=>{
   if(body.failRead)throw new Error("DO_NOT_LEAK_BODY");
   return body.innerText||"";
  },
 });
 assert.equal(relation.target.id,"urn:li:comment:1000000000000000004");
 assert.equal(relation.target.text,"Valid sibling.");
 assert.equal(relation.commentReadErrorCount,3);
 assert.doesNotMatch(JSON.stringify(relation),/DO_NOT_LEAK/);
});
test("LinkedIn returns read failure when no comment root can be read, after actor identity",()=>{
 const a=adapter("linkedin",{}),fixture=linkedInSduiComments([
  {id:"urn:li:comment:2000000000000000001"},{id:"urn:li:comment:2000000000000000002"},
 ]);
 for(const root of fixture.roots)root.querySelectorAll=()=>{throw new Error("private DOM detail")};
 const [unreadable]=a.extractDirectContext(fixture.container,helpers);
 assert.equal(unreadable.actorUrl,"https://www.linkedin.com/in/ayu");
 assert.equal(unreadable.target.captureReason,"comment_read_failed");
 assert.equal(unreadable.commentReadErrorCount,2);
 const noActor=linkedInSduiComments([{id:"urn:li:comment:2000000000000000003"}],{bannerLinkUrls:[]});
 noActor.roots[0].querySelectorAll=()=>{throw new Error("private DOM detail")};
 const [identityUnresolved]=a.extractDirectContext(noActor.container,helpers);
 assert.equal(identityUnresolved.target.captureReason,"actor_identity_unresolved");
 assert.equal(identityUnresolved.commentReadErrorCount,1);
});
test("LinkedIn keeps a valid reply when its parent root cannot be read",()=>{
 const a=adapter("linkedin",{}),fixture=linkedInSduiComments([
  {id:"urn:li:comment:3000000000000000001",text:"Unreadable parent."},
  {id:"urn:li:comment:3000000000000000002",text:"Readable reply.",parentIndex:0},
 ]);
 fixture.roots[0].querySelectorAll=()=>{throw new Error("private parent detail")};
 const relations=a.extractDirectContext(fixture.container,helpers);
 const reply=relations.find((relation)=>relation.target.id==="urn:li:comment:3000000000000000002");
 assert.equal(reply.kind,"feed_reply");assert.equal(reply.target.text,"Readable reply.");
 assert.equal(reply.parent.availability,"reference_only");
 assert.equal(reply.parent.captureReason,"comment_read_failed");
 assert.equal(relations[0].commentReadErrorCount,1);
});
test("LinkedIn does not guess relationship kind or parent body from conflicting IDs",()=>{
 const a=adapter("linkedin",{});
 const conflictingChild=linkedInSduiComments([
  {id:"urn:li:comment:6666666666666666666",text:"Top-level copy."},
  {id:"urn:li:comment:6666666666666666666",text:"Reply copy.",parentIndex:0},
 ],{banner:"Ayu Pratama replied to Bob"});
 const [ambiguous]=a.extractDirectContext(conflictingChild.container,helpers);
 assert.equal(ambiguous.kind,"feed_comment");
 assert.equal(ambiguous.target.captureReason,"comment_identity_ambiguous");
 assert.equal(ambiguous.parent,undefined);
 const conflictingParent=linkedInSduiComments([
  {id:"urn:li:comment:7777777777777777777",text:"Parent copy A."},
  {id:"urn:li:comment:7777777777777777777",text:"Parent copy B."},
  {id:"urn:li:comment:8888888888888888888",text:"Observed reply.",parentIndex:0},
 ],{banner:"Ayu Pratama replied to Bob"});
 const relations=a.extractDirectContext(conflictingParent.container,helpers);
 assert.equal(relations.length,2);
 assert.equal(relations[1].kind,"feed_reply");
 assert.equal(relations[1].target.text,"Observed reply.");
 assert.equal(relations[1].parent.availability,"reference_only");
 assert.equal(relations[1].parent.captureReason,"comment_identity_ambiguous");
});
test("LinkedIn marks duplicate comment evidence with incompatible parents as ambiguous",()=>{
 const a=adapter("linkedin",{}),fixture=linkedInSduiComments([
  {id:"urn:li:comment:9100000000000000001",text:"Parent one."},
  {id:"urn:li:comment:9100000000000000002",text:"Parent two."},
  {id:"urn:li:comment:9100000000000000003",text:"Same reply.",parentIndex:0},
  {id:"urn:li:comment:9100000000000000003",text:"Same reply.",parentIndex:1},
 ]);
 const child=a.extractDirectContext(fixture.container,helpers)
  .find((relation)=>relation.target.id==="urn:li:comment:9100000000000000003");
 assert.equal(child.target.availability,"reference_only");
 assert.equal(child.target.captureReason,"comment_identity_ambiguous");
 assert.equal(child.target.text,undefined);
});
test("LinkedIn merges compatible parent copies and rejects conflicting author URLs",()=>{
 const a=adapter("linkedin",{}),parentId="urn:li:comment:9200000000000000001";
 const compatible=linkedInSduiComments([
  {id:parentId,text:""},
  {id:parentId,text:"Recovered parent body."},
  {id:"urn:li:comment:9200000000000000002",text:"Reply body.",parentIndex:0},
 ]);
 const reply=a.extractDirectContext(compatible.container,helpers)
  .find((relation)=>relation.target.id==="urn:li:comment:9200000000000000002");
 assert.equal(reply.parent.text,"Recovered parent body.");
 assert.equal(reply.parent.availability,"captured");
 const authorConflict=linkedInSduiComments([
  {id:"urn:li:comment:9200000000000000003",text:"Actor-authored copy."},
  {id:"urn:li:comment:9200000000000000003",text:"Other-authored copy.",authorSlug:"different-person"},
 ]);
 const [conflict]=a.extractDirectContext(authorConflict.container,helpers);
 assert.equal(conflict.target.availability,"reference_only");
 assert.equal(conflict.target.captureReason,"comment_identity_ambiguous");
});
test("LinkedIn caps matched comments at eight and reports omitted distinct matches",()=>{
 const a=adapter("linkedin",{});
 const fixture=linkedInSduiComments(Array.from({length:10},(_,index)=>({
  id:`urn:li:comment:${String(index+1).padStart(18,"0")}`,text:`Comment ${index+1}.`,
 })));
 const relations=a.extractDirectContext(fixture.container,helpers);
 assert.equal(relations.length,8);
 assert.equal(relations[0].omittedCommentCount,2);
 assert.equal(relations[7].omittedCommentCount,undefined);
});
test("LinkedIn prioritizes usable comment bodies within the eight-comment cap",()=>{
 const a=adapter("linkedin",{}),fixture=linkedInSduiComments(Array.from({length:9},(_,index)=>({
  id:`urn:li:comment:${String(index+101).padStart(18,"0")}`,
  text:index===8?"Ninth comment has body.":"",
  bodyCount:index===8?1:0,
 })));
 const relations=a.extractDirectContext(fixture.container,helpers);
 assert.equal(relations.length,8);
 assert.equal(relations[7].target.text,"Ninth comment has body.");
 assert.equal(relations[0].omittedCommentCount,1);
 assert.equal(relations.filter((relation)=>relation.target.text==="Ninth comment has body.").length,1);
});
test("LinkedIn explains why matching comment evidence is unavailable",()=>{
 const a=adapter("linkedin",{});
 const reason=(comments,options)=>a.extractDirectContext(
  linkedInSduiComments(comments,options).container,helpers,
 )[0].target.captureReason;
 assert.equal(reason([]),"comments_not_observed");
 assert.equal(reason([{hidden:true,text:"Hidden."}]),"comments_not_visible");
 assert.equal(reason([{authorSlug:"bob",text:"Other author."}]),"matching_comments_not_observed");
 assert.equal(reason([{authorSlug:"bob"},{commentAuthors:[]}]),"comment_author_unresolved");
 assert.equal(reason([{commentAuthors:[]}],{bannerLinkUrls:[]}),"actor_identity_unresolved");
 const missingBody=linkedInSduiComments([{bodyCount:0}]);
 assert.equal(a.extractDirectContext(missingBody.container,helpers)[0].target.captureReason,"comment_body_not_observed");
 const hiddenBody=linkedInSduiComments([{bodyHidden:true}]);
 assert.equal(a.extractDirectContext(hiddenBody.container,helpers)[0].target.captureReason,"comment_body_not_observed");
 const ambiguousBody=linkedInSduiComments([{bodyCount:2}]);
 assert.equal(a.extractDirectContext(ambiguousBody.container,helpers)[0].target.captureReason,"comment_body_ambiguous");
 const unobservedReply=linkedInSduiComments([{authorSlug:"bob"}],{banner:"Ayu Pratama replied to Bob"});
 assert.equal(a.extractDirectContext(unobservedReply.container,helpers)[0].kind,"feed_reply");
});
test("LinkedIn reply requires actual nested parent; phrase in post body is not a relation",()=>{
 const a=adapter("linkedin",{});const parent=comment("bob",null,"Parent comment"),reply=comment("alice",parent,"Reply evidence");
 parent.getAttribute=()=>"urn:li:comment:1111111111111111111";reply.getAttribute=()=>"urn:li:comment:2222222222222222222";
 const relations=a.extractDirectContext(linkedIn("Alice replied to Bob",[parent,reply]),helpers);
 assert.equal(relations[0].kind,"feed_reply");assert.equal(relations[0].parent.text,"Parent comment");assert.equal(relations[0].target.text,"Reply evidence");
 const collapsed=a.extractDirectContext(linkedIn("Alice replied to Bob",[comment()]),helpers);
 assert.equal(collapsed[0].kind,"feed_comment");assert.equal(collapsed[0].target.text,"Comment evidence");assert.equal(collapsed[0].parent,undefined);
 const body=linkedIn("Nothing",[]);body.innerText="Owner\nAlice replied to Bob";assert.equal(a.extractDirectContext(body,helpers).length,0);
 assert.equal(a.extractSemantics(body,helpers).relationshipType,"original");
 const localized=a.extractDirectContext(linkedIn("Alice mengomentari",[]),helpers);assert.equal(localized[0].kind,"feed_comment");
});
