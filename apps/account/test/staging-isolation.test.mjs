import test from "node:test";
import assert from "node:assert/strict";
import { verifyExistingStagingAccess } from "../scripts/verify-staging-access.mjs";

const account="a".repeat(32);
const app={id:"access-staging-account",type:"self_hosted",name:"LifeSpace Account Staging",
  domain:"account-staging.aisr.online",aud:"abcd".repeat(16)};
const allow=[{name:"Only Me",decision:"allow",precedence:1,
  include:[{email:{email:"owner@example.test"}}]}];

function apiFixture({apps=[app],details=app,policies=allow}={}){
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url,method:init.method??"GET"});
    assert.equal(init.method,"GET","read-only preflight must never mutate Cloudflare");
    if(url.endsWith("/access/apps?per_page=100"))return Response.json({success:true,result:apps});
    if(url.endsWith("/access/apps/"+encodeURIComponent(app.id)))return Response.json({success:true,result:details});
    if(url.endsWith("/access/apps/"+encodeURIComponent(app.id)+"/policies"))
      return Response.json({success:true,result:policies});
    throw Error("Unexpected Access GET URL: "+url);
  };
  return {calls,fetcher};
}
const env={CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:"dummy-read-token"};
test("Routine Account release inspects existing isolated Access and strict owner policy using GET only",async()=>{
  const f=apiFixture();
  const result=await verifyExistingStagingAccess({env,fetcher:f.fetcher});
  assert.equal(result.ok,true);
  assert.equal(result.domain,"account-staging.aisr.online");
  assert.equal(result.audiencePresent,true);
  assert.equal(result.mutation,false);
  assert.equal(f.calls.length,3);
  assert.ok(f.calls.every(x=>x.method==="GET"));
  assert.ok(!JSON.stringify(result).includes("owner@example.test"));
});
test("No Access app, duplicate host or untrusted policy fails closed without provisioning",async()=>{
  for(const fixture of [
    {apps:[]},
    {apps:[app,app]},
    {policies:[{decision:"allow",include:[{everyone:{}}]}]},
    {policies:[{decision:"allow",include:[{email_domain:{domain:"example.test"}}]}]},
    {details:{...app,name:"Unreviewed Account"}},
    {details:{...app,aud:"x".repeat(64)}},
  ]){
    const f=apiFixture(fixture);
    await assert.rejects(verifyExistingStagingAccess({env,fetcher:f.fetcher}));
    assert.ok(f.calls.every(x=>x.method==="GET"));
  }
});
test("Missing protected credentials never permit read-only Access inspection",async()=>{
  let called=false;
  await assert.rejects(verifyExistingStagingAccess({
    env:{},fetcher:async()=>{called=true;throw Error("must not call");},
  }));
  assert.equal(called,false);
});
