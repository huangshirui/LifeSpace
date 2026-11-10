import { test } from "node:test";
import assert from "node:assert/strict";
import { accountFetch } from "../worker/index.mjs";

const ACCESS = "a".repeat(50) + ".b.c";
const SPACE = "spc_" + "b".repeat(32);
const USER = "usr_test123";
const OAUTH_ID = "oaz_" + "e".repeat(32);
function setup({ avatarUrl = "https://auth-staging.example.test/assets/users/" + USER + "/avatar", coreStatus = 200 } = {}) {
  const calls = [];
  const token = "test-account-only-user-token";
  let authStatus = "active";
  const ownerAuthorization = () => ({
    id:OAUTH_ID,clientId:"ocli_client1",clientName:"Claimed ChatGPT",verifiedVendor:false,
    resource:"https://core-staging.example.test/mcp/mcp_123456",applicationId:"app_123456",
    spaceId:SPACE,agentId:"agt_123456",allowUserAuthorization:true,
    scopes:["resources:read"],status:authStatus,createdAt:"2026-11-10T00:00:00Z",
    revokedAt:authStatus==="active"?null:"2026-11-10T01:00:00Z",
    // Deliberately emulate future upstream additions: Account must never
    // forward bearer/refresh material or internal credential references.
    accessToken:"would-be-sensitive-access-token",
    refreshToken:"would-be-sensitive-refresh-token",
    credentialRef:"would-be-sensitive-credential-ref",
  });
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
    if(path==="/api/v1/me/oauth/authorizations"){
      assert.equal(new URL(request.url).searchParams.get("offset"),"0");
      return Response.json({data:{items:[ownerAuthorization()],nextOffset:null}});
    }
    if(path==="/api/v1/me/oauth/authorizations/"+OAUTH_ID)
      return Response.json({data:ownerAuthorization()});
    if(path==="/api/v1/me/oauth/authorizations/"+OAUTH_ID+"/revoke"){
      assert.equal(request.method,"POST");
      assert.deepEqual(await request.json(),{});
      authStatus="revoked";
      return Response.json({data:{id:OAUTH_ID,revoked:true}});
    }
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
        id:SPACE,name:"Personal Space",timezone:"Asia/Shanghai",version:2,access:"owner",
      }});
    }
    if(path==="/api/v1/spaces/"+SPACE+"/external-connections") {
      if(coreStatus!==200)return Response.json({error:{code:"FORBIDDEN"}},{status:coreStatus});
      return Response.json({data:{items:[{
        id:"exs_"+"b".repeat(32),spaceId:SPACE,providerKey:"notion",
        displayName:"Private Notion",status:"active",access:"read",
        createdAt:"2026-11-10T00:00:00Z",
        credentialRef:"should-not-appear-in-browser",resourceDiscovery:true,
      }]}});
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
  const rawSession=await session.clone().text();
  const profile=(await session.json()).data.user;
  assert.deepEqual(profile,{id:USER,displayName:"User test",
    avatarUrl:"https://auth-staging.example.test/assets/users/"+USER+"/avatar"});
  assert.ok(!rawSession.includes(t.token));
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

test("Account Center independently revokes owner OAuth authorization with signed-CSRF gate",async()=>{
  const t=setup();
  const listed=await t.request("/api/account/authorizations?offset=0");
  assert.equal(listed.status,200);
  const row=(await listed.json()).data.items[0];
  assert.equal(row.id,OAUTH_ID);
  assert.equal(row.status,"active");
  assert.equal(row.clientName,"Claimed ChatGPT");
  assert.ok(!JSON.stringify(row).includes(t.token));
  assert.equal(Object.hasOwn(row,"accessToken"),false);
  assert.equal(Object.hasOwn(row,"refreshToken"),false);
  assert.equal(Object.hasOwn(row,"credentialRef"),false);
  const detailed=await t.request("/api/account/authorizations/"+OAUTH_ID);
  const detail=(await detailed.json()).data;
  assert.equal(detail.id,OAUTH_ID);
  assert.equal(Object.hasOwn(detail,"accessToken"),false);
  assert.equal(Object.hasOwn(detail,"refreshToken"),false);
  assert.equal(Object.hasOwn(detail,"credentialRef"),false);
  const withoutCsrf=await t.request("/api/account/authorizations/"+OAUTH_ID+"/revoke",{
    method:"POST",headers:{"origin":"https://account-staging.example.test",
      "sec-fetch-site":"same-origin","content-type":"application/json"},
    body:JSON.stringify({intent:"revoke-oauth-authorization",authorizationId:OAUTH_ID}),
  });
  assert.equal(withoutCsrf.status,403);
  const session=await t.request("/api/session");
  const csrf=(await session.json()).data.csrfToken;
  const cookie=session.headers.get("set-cookie").split(";")[0];
  const allowed=await t.request("/api/account/authorizations/"+OAUTH_ID+"/revoke",{
    method:"POST",
    headers:{"origin":"https://account-staging.example.test",
      "sec-fetch-site":"same-origin","content-type":"application/json",
      "x-lifespace-csrf":csrf,"cookie":cookie},
    body:JSON.stringify({intent:"revoke-oauth-authorization",authorizationId:OAUTH_ID}),
  });
  assert.equal(allowed.status,200);
  assert.deepEqual((await allowed.json()).data,{id:OAUTH_ID,revoked:true});
  const after=await t.request("/api/account/authorizations?offset=0");
  assert.equal((await after.json()).data.items[0].status,"revoked");
});

test("External Data listing uses current Space manager Core authority and strips provider credential references",async()=>{
  const t=setup();
  const external=await t.request("/api/account/spaces/"+SPACE+"/external-connections");
  assert.equal(external.status,200);
  const item=(await external.json()).data.items[0];
  assert.equal(item.providerKey,"notion");
  assert.equal(item.displayName,"Private Notion");
  assert.equal(item.access,"read");
  assert.ok(!JSON.stringify(item).includes("credentialRef"));
  assert.ok(!JSON.stringify(item).includes("should-not-appear"));
  assert.ok(t.calls.some(c=>c.path==="/api/v1/spaces/"+SPACE+"/external-connections"
    && c.auth==="Bearer "+t.token));
  assert.equal((await t.request("/api/account/spaces/"+SPACE+"/external-connections?userId=usr_other")).status,400);
  assert.equal((await t.request("/api/account/spaces/spc_other/external-connections")).status,404);
  const blocked=setup({coreStatus:403});
  assert.equal((await blocked.request("/api/account/spaces/"+SPACE+"/external-connections")).status,403);
});
