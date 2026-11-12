import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html=readFileSync(new URL("../public/center.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../public/center.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/center.css",import.meta.url),"utf8");

test("Account Center binds every imperative JavaScript ID to an actual page element",()=>{
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/gu)].map(x=>x[1]));
  const used=new Set([...js.matchAll(/\$\("([^"]+)"\)/gu)].map(x=>x[1]));
  assert.ok(used.size>25,"UI must exercise the real page controller");
  assert.deepEqual([...used].filter(id=>!ids.has(id)),[]);
});

test("Account Center is not the old OAuth Consent/parallel overview implementation",()=>{
  for(const key of ["account","spaces","connections","audit"])
    assert.match(html,new RegExp('data-panel="'+key+'"'));
  assert.doesNotMatch(html,/data-panel="overview"/u);
  assert.match(html,/href="#account"/u);
  assert.match(html,/Powered by LifeSpace/u);
  assert.match(html,/data-tab="oauth"/u);
  assert.match(html,/data-tab="delegations"/u);
  assert.match(html,/data-tab="external"/u);
  assert.match(html,/id="revoke-dialog"/u);
  assert.match(html,/id="profile-form"/u);
  assert.match(html,/id="space-create-form"/u);
  assert.match(html,/id="space-invite-form"/u);
  assert.match(html,/href="#i-link-2"/u);
  assert.doesNotMatch(html,/MY SPACES|online-mark|使用独立的委托管理页/u);
  assert.doesNotMatch(js,/有效授权/u);
  assert.match(css,/@media\(max-width:650px\)/u);
});

test("Account Center uses domain-neutral browser title and no inert developer-management tabs",()=>{
  for(const file of ["center.html","index.html","delegation.html","delegations.html"]){
    const page=readFileSync(new URL("../public/"+file,import.meta.url),"utf8");
    assert.match(page,/<title>账户中心<\/title>/u,file);
    assert.doesNotMatch(page,/AISR Account|AISR\s*<|\bAISR\b/u,file);
  }
  assert.match(html,/<strong>账户中心<\/strong>/u);
  assert.match(js,/document\.title="账户中心"/u);
  assert.doesNotMatch(html,/data-tab="(direct|event)"|data-tab-panel="(direct|event)"/u);
  assert.doesNotMatch(js,/new Set\(\["oauth","delegations","direct"/u);
  assert.match(html,/其他应用内委托将在统一查询接入后显示/u);
});

test("Delegation cards expose all three lifetime labels and expiry without needing technical details",()=>{
  assert.match(js,/item\.mode==="once"\)return "一次性"/u);
  assert.match(js,/item\.mode==="timed"\)return "限时"/u);
  assert.match(js,/return "长期 · 直到撤销"/u);
  assert.match(js,/el\("span","tag",item\.expiresAt\s*\?/u);
  assert.match(js,/到期：/u);
  assert.match(js,/无固定到期时间/u);
});

test("Account Center renders upstream content as text and revocation is an explicit POST",()=>{
  assert.match(js,/function el\(tag,className,value\)/u);
  assert.match(js,/node\.textContent=String\(value\)/u);
  assert.doesNotMatch(js,/innerHTML|localStorage|sessionStorage/iu);
  assert.match(js,/intent:"revoke-oauth-authorization"/u);
  assert.match(js,/intent:"revoke-user-delegation"/u);
  assert.match(js,/method:"POST"/u);
  assert.match(js,/"x-lifespace-csrf":state\.csrf/u);
  assert.match(js,/api\("\/api\/account\/authorizations\?offset=/u);
});
