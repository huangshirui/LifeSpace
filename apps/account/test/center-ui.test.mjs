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
  assert.match(html,/未撤销.*不保证当前 Agent/u);
  assert.doesNotMatch(js,/有效授权/u);
  assert.match(css,/@media\(max-width:650px\)/u);
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
