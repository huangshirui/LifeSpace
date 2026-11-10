import { test } from "node:test";
import assert from "node:assert/strict";
import { accountFetch } from "../worker/index.mjs";

const ACCESS = "a".repeat(50) + ".b.c";
const SPACE = "spc_" + "b".repeat(32);
const USER = "usr_test123";
function setup({ avatarUrl = "https://auth-staging.example.test/assets/users/" + USER + "/avatar", coreStatus = 200 } = {}) {
  const calls = [];
  const token = "test-account-only-user-token";
  const identity = { fetch: async request => {
    const url = new URL(request.url), path = url.pathname;
    calls.push({ service: "identity", path, auth: request.headers.get("authorization") });
    if(path==="/internal/v1/access/tokens"){
      assert.equal(request.headers.get("authorization"),"Bearer account-lsa-test");
      const payload=await request.json();
      assert.equal(payload.accessAssertion,ACCESS);
      return Response.json({data:{accessToken:token}});
    }
    assert.equal(request.headers.get("authorization"),"Bearer "+token);
    if(path==="/api/v1/me")return Response.json({data:{
      id:USER,displayName:"User test",status:"active",avatarUrl,
    }});
    if(path==="/api/v1/me/web-login")return Response.json({data:{
      email:"verified@example.test",linked:true,status:"linked",version:1,
    }});
    throw Error("Unexpected Identity request: "+path);
  }};
  const core = { fetch: async request => {
    const path = new URL(request.url).pathname;
    calls.push({service:"core",path,auth:request.headers.get("authorization")});
    assert.equal(request.headers.get("authorization"),"Bearer "+token);
    if(path==="/api/v1/me/spaces")return Response.json({data:[{
      id:SPACE,name:"Personal Space",timezone:"Asia/Shanghai",role:"owner",version:2,
    }]});
    if(path==="/api/v1/spaces/"+SPACE){
      if(coreStatus!==200)return Response.json({error:{code:"FORBIDDEN"}},{status:coreStatus});
      return Response.json({data:{
        id:SPACE,name:"Personal Space",timezone:"Asia/Shanghai",version:2,access:{read:true,manage:true},
      }});
    }
    if(path==="/api/v1/spaces/"+SPACE+"/members")return Response.json({data:[{
      userId:USER,displayName:"User test",role:"owner",
    }]});
    return Response.json({error:{code:"SPACE_NOT_FOUND"}},{status:404});
  }};
  const env={
    ENVIRONMENT:"staging",
    IDENTITY_APPLICATION_CREDENTIAL:"account-lsa-test",
    ACCOUNT_CSRF_SECRET:"test-only-long-csrf-secret-longer-than-thirty-two",
    IDENTITY_BASE_URL:"https://auth-staging.example.test",
    CORE_BASE_URL:"https://core-staging.example.test",
    IDENTITY:identity,CORE:core,
    ASSETS:{fetch:async()=>new Response("<html>asset</html>",{headers:{"content-type":"text/html"}})},
  };
  const request=(path, init={})=>accountFetch(new Request("https://account-staging.example.test"+path,{
    ...init,headers:{"cf-access-jwt-assertion":ACCESS,...(init.headers||{})},
  }),env);
  return {request,calls,token};
}
test("Account root becomes center while isolated OAuth pages and headers remain intact",async()=>{
  const t=setup();
  const index=await t.request("/");
  assert.equal(index.status,302);
  assert.equal(index.headers.get("location"),"https://account-staging.example.test/center");
  const consent=await t.request("/oauth/consent?request_id=oar_test");
  assert.equal(consent.status,200);
  assert.match(consent.headers.get("content-security-policy"),/frame-ancestors 'none'/);
  assert.equal(consent.headers.get("referrer-policy"),"no-referrer");
});
test("Account Center reads only verified user profile, declared mailbox and own spaces",async()=>{
  const t=setup();
  const session=await t.request("/api/session");
  assert.equal(session.status,200);
  const profile=(await session.json()).data.user;
  assert.deepEqual(profile,{id:USER,displayName:"User test",
    avatarUrl:"https://auth-staging.example.test/assets/users/"+USER+"/avatar"});
  assert.ok(!(await session.clone().text()).includes(t.token));
  const email=await t.request("/api/account/login-email");
  assert.equal(email.status,200);
  assert.deepEqual((await email.json()).data,{email:"verified@example.test",status:"linked",linked:true});
  const spaces=await t.request("/api/account/spaces");
  assert.equal(spaces.status,200);
  assert.deepEqual((await spaces.json()).data,[{id:SPACE,name:"Personal Space",timezone:"Asia/Shanghai",role:"owner"}]);
  const detail=await t.request("/api/account/spaces/"+SPACE);
  assert.equal(detail.status,200);
  assert.equal((await detail.json()).data.version,2);
  const members=await t.request("/api/account/spaces/"+SPACE+"/members");
  assert.equal(members.status,200);
  assert.deepEqual((await members.json()).data,[{userId:USER,displayName:"User test",role:"owner"}]);
  for(const entry of t.calls.filter(entry=>entry.service==="core")){
    assert.equal(entry.auth,"Bearer "+t.token);
    assert.ok(!entry.path.includes(USER));
  }
});
test("Account Center fails closed for unknown Space, extra parameters and POST mutations",async()=>{
  const t=setup({coreStatus:403});
  assert.equal((await t.request("/api/account/spaces/"+SPACE)).status,403);
  assert.equal((await t.request("/api/account/spaces/"+SPACE+"/members/../../oops")).status,404);
  assert.equal((await t.request("/api/account/spaces?userId=usr_other")).status,400);
  assert.equal((await t.request("/api/account/login-email?userId=usr_other")).status,400);
  assert.equal((await t.request("/api/account/spaces",{method:"POST",headers:{
    origin:"https://account-staging.example.test","sec-fetch-site":"same-origin",
    "content-type":"application/json",
  },body:"{}"})).status,405);
  const noAccess=await accountFetch(new Request("https://account-staging.example.test/api/session"),{
    IDENTITY_APPLICATION_CREDENTIAL:"account-lsa-test",
    IDENTITY_BASE_URL:"https://auth-staging.example.test",
    ENVIRONMENT:"staging",
  });
  assert.equal(noAccess.status,401);
});
test("Account Center strips an untrusted avatar origin before reaching the browser",async()=>{
  const t=setup({avatarUrl:"https://evil.example.test/assets/users/"+USER+"/avatar"});
  const result=await t.request("/api/session");
  assert.equal(result.status,200);
  assert.equal((await result.json()).data.user.avatarUrl,null);
});
