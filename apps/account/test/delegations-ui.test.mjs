import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script=readFileSync(new URL("../public/delegations.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../public/delegations.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/site.css",import.meta.url),"utf8");

class FakeElement {
  constructor(tag="div"){
    this.tagName=tag;this.children=[];this.listeners={};this.textContent="";
    this.disabled=false;this.open=false;this.parent=null;this.classes=new Set(["hidden"]);
    this.classList={toggle:(name,enabled)=>enabled?this.classes.add(name):this.classes.delete(name)};
  }
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  addEventListener(name,fn){this.listeners[name]=fn;}
  trigger(name,event={preventDefault(){}}){return this.listeners[name]?.(event);}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
function fixture(){
  const ids=["revoke-title","revoke-message","revoke-error","revoke-dialog",
    "revoke-confirm","revoke-cancel","feedback","items","empty","more",
    "loading","error","error-message","content","retry"];
  const elements=Object.fromEntries(ids.map(id=>[id,new FakeElement()]));
  const requests=[];
  let shouldFail=false;
  const response=(ok,data,message)=>({ok,json:async()=>ok?{data}:{error:{message}}});
  const sample={
    id:"dlg_synthetic",clientId:"https://example.com/oauth/client.json",
    resource:"https://core.example.test/mcp/mcp_test",agentId:"agt_synthetic",
    applicationId:"app_synthetic",spaceId:"spc_synthetic",modelKey:"person",
    operation:"query",mode:"until_revoked",createdAt:"2026-11-10T00:00:00Z",expiresAt:null,
  };
  const fetch=async (url,options={})=>{
    requests.push({url,...options});
    if(url==="/api/session")return response(true,{csrfToken:"synthetic-csrf"});
    if(url==="/api/delegations?offset=0")return response(true,{items:[sample],nextOffset:null});
    if(url==="/api/delegations/revoke")return shouldFail
      ?response(false,null,"测试撤销失败"):response(true,{id:sample.id,revoked:true});
    throw Error("Unexpected URL "+url);
  };
  const document={getElementById:id=>elements[id],createElement:tag=>new FakeElement(tag)};
  runInNewContext(script,{document,fetch,URL,Date,console});
  return {elements,requests,setFail:value=>{shouldFail=value;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test("delegation page uses independent full-width list and native accessible dialog",()=>{
  assert.match(html,/id="items" class="delegation-list"/u);
  assert.doesNotMatch(html,/id="items" class="fields"/u);
  assert.match(css,/\.delegation-list\s*\{[^}]*grid-template-columns:minmax\(0,1fr\)/u);
  assert.match(html,/<dialog id="revoke-dialog"[^>]*aria-labelledby="revoke-title"/u);
  assert.match(html,/id="revoke-error"[^>]*role="alert"/u);
  assert.match(html,/id="feedback"[^>]*role="status"/u);
  assert.doesNotMatch(script,/\b(?:confirm|alert)\s*\(/u);
});

test("cancel makes no mutation; revoke error is inline; success removes card and reports status",async()=>{
  const t=fixture();await flush();await flush();
  const item=t.elements.items.children[0];
  assert.ok(item,"synthetic delegation should render");
  assert.equal(item.className,"delegation-item");
  assert.match(item.children[0].children[0].children[0].textContent,/人物 · 查询/u);
  const button=item.children[0].children[1];
  await button.trigger("click");
  assert.equal(t.elements["revoke-dialog"].open,true);
  assert.equal(t.requests.filter(x=>x.url.includes("/revoke")).length,0);
  await t.elements["revoke-cancel"].trigger("click");
  assert.equal(t.elements["revoke-dialog"].open,false);
  assert.equal(t.requests.filter(x=>x.url.includes("/revoke")).length,0);
  await button.trigger("click");
  t.setFail(true);
  await t.elements["revoke-confirm"].trigger("click");
  assert.equal(t.elements["revoke-dialog"].open,true);
  assert.match(t.elements["revoke-error"].textContent,/测试撤销失败/u);
  assert.equal(t.elements.items.children.length,1);
  t.setFail(false);
  await t.elements["revoke-confirm"].trigger("click");
  assert.equal(t.elements["revoke-dialog"].open,false);
  assert.equal(t.elements.items.children.length,0);
  assert.match(t.elements.feedback.textContent,/已撤销/u);
  const revoked=t.requests.filter(x=>x.url==="/api/delegations/revoke");
  assert.equal(revoked.length,2);
  assert.equal(revoked[1].headers["x-lifespace-csrf"],"synthetic-csrf");
  assert.deepEqual(JSON.parse(revoked[1].body),{
    intent:"revoke-user-delegation",delegationId:"dlg_synthetic",
  });
});
