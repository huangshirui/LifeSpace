import test from "node:test";
import assert from "node:assert/strict";
import { accountFetch } from "../worker/index.mjs";

const ACCESS="a".repeat(50)+".b.c";
const USER="usr_selftest";
const SPACE="spc_"+"c".repeat(32);
const created="spc_"+"d".repeat(32);
const ORIGIN="https://account-staging.example.test";
const token="short-lived-account-user-only";
const avatarUrl="https://auth-staging.example.test/assets/users/"+USER+"/avatar";

function setup(){
  const requests=[];
  let displayName="Test User",email="old@example.test",version=2,linked=true;
  const env={
    ENVIRONMENT:"staging",ACCOUNT_CSRF_SECRET:"a-local-test-secret-with-at-least-thirty-two-characters",
    IDENTITY_APPLICATION_CREDENTIAL:"lsa_test_private",
    IDENTITY_BASE_URL:"https://auth-staging.example.test",
    CORE_BASE_URL:"https://core-staging.example.test",
    IDENTITY:{fetch:async req=>{
      const path=new URL(req.url).pathname;
      requests.push({who:"identity",path,method:req.method});
      if(path==="/internal/v1/access/tokens"){
        assert.equal(req.headers.get("authorization"),"Bearer lsa_test_private");
        const data=await req.json();
        assert.deepEqual(data.requestedScopes,
          ["profile:read","profile:write","spaces:read","spaces:write","spaces:manage"]);
        return Response.json({data:{accessToken:token}});
      }
      assert.equal(req.headers.get("authorization"),"Bearer "+token);
      if(path==="/api/v1/me" && req.method==="GET")
        return Response.json({data:{id:USER,status:"active",displayName,avatarUrl}});
      if(path==="/api/v1/me" && req.method==="PATCH"){
        const input=await req.json();
        assert.deepEqual(Object.keys(input),["displayName"]);
        displayName=input.displayName;
        return Response.json({data:{id:USER,status:"active",displayName,avatarUrl}});
      }
      if(path==="/api/v1/me/web-login" && req.method==="GET")
        return Response.json({data:{email,status:linked?"linked":"pending",linked,version}});
      if(path==="/api/v1/me/web-login" && req.method==="PATCH"){
        const input=await req.json();
        assert.deepEqual(input,{email:"new@example.test",version:2});
        email=input.email;version+=1;linked=false;
        return Response.json({data:{email,version,linked:false,status:"pending"}});
      }
      if(path==="/api/v1/me/avatar" && req.method==="PUT"){
        const body=await req.formData();
        const image=body.get("avatar");
        assert.equal(image.type,"image/png");
        assert.equal(image.size,7);
        return Response.json({data:{avatarUrl}});
      }
      throw Error("Unexpected Identity path "+path);
    }},
    CORE:{fetch:async req=>{
      const path=new URL(req.url).pathname;
      requests.push({who:"core",path,method:req.method});
      assert.equal(req.headers.get("authorization"),"Bearer "+token);
      if(path==="/api/v1/me/spaces")
        return Response.json({data:[{id:SPACE,name:"My Space",timezone:"Asia/Shanghai",role:"owner"}]});
      if(path==="/api/v1/spaces" && req.method==="POST"){
        const input=await req.json();
        assert.deepEqual(input,{name:"Project",timezone:"Asia/Shanghai",ownerDisplayName:"Test User"});
        return Response.json({data:{id:created,name:"Project",role:"owner",timezone:"Asia/Shanghai"}}, {status:201});
      }
      if(path==="/api/v1/space-invites/preview"){
        assert.deepEqual(await req.json(),{token:"test-invite"});
        return Response.json({data:{space:{id:SPACE,name:"Friends",memberCount:3,timezone:"Asia/Shanghai"},role:"viewer",canJoin:true}});
      }
      if(path==="/api/v1/space-invites/join"){
        assert.deepEqual(await req.json(),{token:"test-invite",displayName});
        return Response.json({data:{spaceId:SPACE,role:"viewer",personId:"per_test",joinedAt:"2026-11-10T00:00:00Z"}}, {status:201});
      }
      throw Error("Unexpected Core path "+path);
    }},
    ASSETS:{fetch:async()=>new Response("ok")},
  };
  const request=(path,init={})=>accountFetch(new Request(ORIGIN+path,{
    ...init,headers:{"cf-access-jwt-assertion":ACCESS,...init.headers},
  }),env);
  async function auth(){
    const r=await request("/api/session");
    assert.equal(r.status,200);
    const csrf=(await r.json()).data.csrfToken;
    return {csrf,cookie:r.headers.get("set-cookie").split(";")[0]};
  }
  function post(path,data,{csrf,cookie},headers={}){
    return request(path,{
      method:"POST",headers:{origin:ORIGIN,"sec-fetch-site":"same-origin",
        "content-type":"application/json","x-lifespace-csrf":csrf,cookie,...headers},
      body:JSON.stringify(data),
    });
  }
  return {request,post,auth,requests};
}
test("Account self-service is gated by verified session, same-origin and CSRF",async()=>{
  const t=setup();
  const params={intent:"update-profile",displayName:"Alice"};
  const session=await t.auth();
  assert.equal((await t.post("/api/account/profile",params,{csrf:"wrong",cookie:session.cookie})).status,403);
  assert.equal((await t.post("/api/account/profile",params,session,{"origin":"https://evil.test"})).status,403);
  assert.equal((await t.post("/api/account/profile",{...params,userId:"usr_other"},session)).status,400);
  assert.equal((await t.request("/api/account/profile")).status,405);
  assert.equal((await t.request("/api/account/spaces/create")).status,405);
  assert.equal((await t.request("/api/account/profile",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(params)})).status,403);
});
test("Profile and mailbox are updated only by Identity with current user token, pending verification",async()=>{
  const t=setup(),a=await t.auth();
  const saved=await t.post("/api/account/profile",{intent:"update-profile",displayName:"Alice"},a);
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).data,{id:USER,displayName:"Alice"});
  const state=await t.request("/api/account/login-email");
  assert.deepEqual((await state.json()).data,{email:"old@example.test",status:"linked",linked:true,version:2});
  const changed=await t.post("/api/account/login-email/change",{
    intent:"change-login-email",email:"new@example.test",version:2,
  },a);
  assert.equal(changed.status,200);
  assert.deepEqual((await changed.json()).data,{
    email:"new@example.test",status:"pending",linked:false,version:3,
  });
  assert.ok(t.requests.some(x=>x.who==="identity"&&x.path==="/api/v1/me/web-login"&&x.method==="PATCH"));
  assert.ok(!JSON.stringify(await (await t.request("/api/session")).json()).includes(token));
});
test("Space creation and invite preview/accept use Core, never admin credentials",async()=>{
  const t=setup(),a=await t.auth();
  const create=await t.post("/api/account/spaces/create",{
    intent:"create-space",name:"Project",timezone:"Asia/Shanghai",
  },a);
  assert.equal(create.status,201);
  assert.equal((await create.json()).data.id,created);
  const preview=await t.post("/api/account/spaces/invite-preview",{
    intent:"preview-space-invite",token:"test-invite",
  },a);
  assert.equal(preview.status,200);
  assert.deepEqual((await preview.json()).data,{
    space:{id:SPACE,name:"Friends"},role:"viewer",canJoin:true,
  });
  const join=await t.post("/api/account/spaces/join",{
    intent:"join-space",token:"test-invite",
  },a);
  assert.equal(join.status,201);
  assert.deepEqual((await join.json()).data,{spaceId:SPACE,role:"viewer"});
  assert.ok(t.requests.filter(x=>x.who==="core").every(x=>x.method==="POST"));
  assert.equal((await t.post("/api/account/spaces/create",{
    intent:"create-space",name:"Project",timezone:"Asia/Shanghai",userId:"usr_other",
  },a)).status,400);
});
test("Avatar multipart upload validates type and forwards no bearer token to browser",async()=>{
  const t=setup(),a=await t.auth();
  async function upload(file,csrf=a.csrf,cookie=a.cookie){
    const data=new FormData();data.set("avatar",file,"avatar.png");
    return t.request("/api/account/profile/avatar",{method:"POST",headers:{
      origin:ORIGIN,"sec-fetch-site":"same-origin","x-lifespace-csrf":csrf,cookie,
    },body:data});
  }
  const accepted=await upload(new File(["1234567"],"avatar.png",{type:"image/png"}));
  assert.equal(accepted.status,200);
  assert.deepEqual((await accepted.json()).data,{avatarUrl});
  assert.equal((await upload(new File(["abc"],"no.txt",{type:"text/plain"}))).status,422);
  assert.equal((await upload(new File(["abc"],"avatar.png",{type:"image/png"}),"wrong")).status,403);
});
test("Legacy standalone Delegation management redirects into the consolidated tab",async()=>{
  const t=setup();
  const r=await t.request("/delegations");
  assert.equal(r.status,302);
  assert.equal(r.headers.get("location"),ORIGIN+"/center#connections/delegations");
});
