import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const code=readFileSync(new URL("../public/center.js",import.meta.url),"utf8");
const spaces=[{id:"spc_a",name:"A",role:"owner"},{id:"spc_b",name:"B",role:"admin"},{id:"spc_c",name:"C",role:"viewer"}];
const connection=(name,spaceId="spc_a")=>({id:"exs_synthetic",displayName:name,spaceId,providerKey:"notion",status:"active",access:"write",createdAt:"2026-11-17T00:00:00Z"});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function node(tag="div"){
  return {
    tag,textContent:"",value:"",children:[],hidden:false,disabled:false,dataset:{},events:new Map(),
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    append(...children){this.children.push(...children);if(this.tag==="select"&&this.children.length===children.length)this.value=this.children[0]?.value??"";},
    replaceChildren(...children){this.children=[];if(this.tag==="select")this.value="";this.append(...children);},
    setAttribute(){},removeAttribute(){},addEventListener(type,fn){this.events.set(type,fn);},
    showModal(){this.open=true;},close(){this.open=false;},
  };
}
async function fixture(){
  const nodes=new Map(),requests=[];
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,node(id==="external-space"?"select":"div"));
    return nodes.get(id);
  };
  const fetch=async url=>{
    if(url==="/api/session?include=login-email")return Response.json({data:{user:{id:"usr_test",displayName:"Test",avatarUrl:null},csrfToken:"test-csrf",loginEmail:{email:null,status:"unlinked",version:0}}});
    return new Promise(resolve=>requests.push({url,ok:data=>resolve(Response.json({data})),fail:()=>resolve(Response.json({error:{message:"stale error"}},{status:503}))}));
  };
  const location={hash:"#account"};
  const exposed=runInNewContext(code+"\n;({state,loadExternal,selectTab,navigate})",{
    document:{getElementById:element,createElement:node,querySelectorAll:()=>[]},location,window:{addEventListener(){}},fetch,Response,
  });
  await flush();
  const cards=()=>element("external-items").children;
  const title=()=>cards()[0]?.children[0].children[0].children[0].textContent;
  return {element,requests,location,exposed,cards,title};
}
test("Data Connections click + hashchange share one load and render exactly one card",async()=>{
  const t=await fixture();
  t.exposed.selectTab("external");
  t.exposed.navigate();
  assert.equal(t.requests.length,1);
  assert.equal(t.requests[0].url,"/api/account/spaces");
  t.requests[0].ok(spaces);await flush();
  assert.equal(t.requests.length,2);
  assert.match(t.requests[1].url,/spc_a\/external-connections$/u);
  t.requests[1].ok({items:[connection("Notion test")]});await flush();
  assert.equal(t.cards().length,1);
  assert.equal(t.title(),"Notion test");
  assert.equal(t.exposed.state.externalLoaded,true);
  assert.equal(t.element("external-space").children.length,2);
});
test("latest Space selection wins, even A→B→A, with stale success and failure ignored",async()=>{
  const t=await fixture();
  const initial=t.exposed.loadExternal(true);
  t.requests[0].ok(spaces);await flush();
  const select=t.element("external-space");
  select.value="spc_b";const second=t.exposed.loadExternal(false);
  select.value="spc_a";const third=t.exposed.loadExternal(false);
  t.requests[3].ok({items:[connection("latest A")]});await third;
  t.requests[1].ok({items:[connection("old A")]});await initial;
  t.requests[2].fail();await second;
  assert.equal(t.cards().length,1);
  assert.equal(t.title(),"latest A");
  assert.equal(t.element("external-message").hidden,true);
  assert.equal(t.exposed.state.externalLoaded,true);
});
test("explicit refresh is a fresh read, preserves valid selection and ignores stale Space-list errors",async()=>{
  const t=await fixture();
  const first=t.exposed.loadExternal(true);t.requests[0].ok(spaces);await flush();
  t.requests[1].ok({items:[connection("A")]});await first;
  const select=t.element("external-space");select.value="spc_b";
  const selected=t.exposed.loadExternal(false);
  t.requests[2].ok({items:[connection("B","spc_b")]});await selected;
  const refresh=t.element("refresh-external").events.get("click");
  const p=refresh();
  t.requests[3].ok(spaces);await flush();
  assert.match(t.requests[4].url,/spc_b\/external-connections$/u);
  t.requests[4].ok({items:[connection("B refreshed","spc_b")]});await p;
  assert.equal(t.title(),"B refreshed");assert.equal(t.cards().length,1);
  const stale=refresh();const latest=refresh();
  t.requests[6].ok(spaces);await flush();
  t.requests[7].ok({items:[connection("latest")]});await latest;
  t.requests[5].fail();await stale;
  assert.equal(t.cards().length,1);assert.equal(t.title(),"latest");
  assert.equal(t.element("external-message").hidden,true);
});
