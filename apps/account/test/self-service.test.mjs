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

function setup({spaceRole="owner",settingsStatus=200}={}){
  const requests=[];
  let displayName="Test User",email="old@example.test",version=2,linked=true,ceiling=null;
  let spaceVersion=3,spaceName="My Space",spaceTimezone="Asia/Shanghai",active=true;
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
      const memberPath="/api/v1/spaces/"+SPACE+"/members/usr_child/model-access";
      if(path===memberPath&&req.method==="GET")return Response.json({data:{
        spaceId:SPACE,userId:"usr_child",role:"editor",models:[
          {modelKey:"task",displayName:"Task",available:true,ceiling,baseAccess:["read","write"],boundedAccess:ceiling==="none"?[]:["read","write"],providerKey:"must-not-leak"},
        ],secret:"must-not-leak"}});
      if(path===memberPath+"/task"&&req.method==="PUT"){
        const input=await req.json();assert.deepEqual(input,{maxAccess:"none"});ceiling=input.maxAccess;
        return new Response(null,{status:204});
      }
      if(path===memberPath+"/task"&&req.method==="DELETE"){ceiling=null;return new Response(null,{status:204});}
      if(path.includes("/members/usr_denied/model-access"))return Response.json({error:{code:"FORBIDDEN"}},{status:403});
      const settingsPath="/api/v1/spaces/"+SPACE;
      if(path===settingsPath&&req.method==="PATCH"){
        const input=await req.json();
        assert.deepEqual(Object.keys(input).sort(),["name","timezone","version"]);
        if(settingsStatus!==200)return Response.json({error:{code:"SYNTHETIC",secret:"must-not-leak"}},{status:settingsStatus});
        if(!["owner","admin"].includes(spaceRole))return new Response(null,{status:403});
        if(input.version!==spaceVersion)return new Response(null,{status:409});
        spaceVersion++;spaceName=input.name;spaceTimezone=input.timezone;
        return Response.json({data:{id:SPACE,name:spaceName,timezone:spaceTimezone,version:spaceVersion,secret:"must-not-leak"}});
      }
      if(path===settingsPath+"/close"&&req.method==="POST"){
        const input=await req.json();assert.deepEqual(Object.keys(input),["version"]);
        if(settingsStatus!==200)return new Response(null,{status:settingsStatus});
        if(spaceRole!=="owner")return new Response(null,{status:403});
        if(input.version!==spaceVersion)return new Response(null,{status:409});
        active=false;return new Response(null,{status:204});
      }
      if(path===settingsPath+"/leave"&&req.method==="POST"){
        assert.deepEqual(await req.json(),{});
        if(settingsStatus!==200)return new Response(null,{status:settingsStatus});
        if(spaceRole==="owner")return new Response(null,{status:409});
        active=false;return new Response(null,{status:204});
      }
      if(path==="/api/v1/me/spaces")
        return Response.json({data:active?[{id:SPACE,name:spaceName,timezone:spaceTimezone,role:spaceRole}]:[]});
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

test("Member model ceilings use only current User authority with target confirmation and CSRF",async()=>{
  const t=setup(),a=await t.auth(),base="/api/account/spaces/"+SPACE+"/members/usr_child/model-access";
  const payload={intent:"change-member-model-access",confirmSpaceId:SPACE,confirmUserId:"usr_child",confirmModelKey:"task",maxAccess:"none"};
  const initial=await t.request(base);assert.equal(initial.status,200);
  const first=await initial.json();assert.equal(first.data.models[0].ceiling,null);
  assert.ok(!JSON.stringify(first).includes("must-not-leak"));
  const count=()=>t.requests.filter(x=>x.who==="core").length;
  const before=count();
  assert.equal((await t.post(base+"/task",payload,{csrf:"wrong",cookie:a.cookie})).status,403);
  assert.equal((await t.post(base+"/task",payload,a,{origin:"https://evil.test"})).status,403);
  assert.equal((await t.post(base+"/task",{...payload,confirmModelKey:"event"},a)).status,400);
  assert.equal((await t.post(base+"/task",{...payload,actorUserId:"usr_admin"},a)).status,400);
  assert.equal((await t.post(base+"/task",{...payload,maxAccess:"inherit"},a)).status,400);
  assert.equal(count(),before);
  assert.equal((await t.request(base+"/task")).status,405);
  assert.equal((await t.post(base,payload,a)).status,405);
  assert.equal((await t.post(base+"/task",payload,a)).status,200);
  assert.equal((await (await t.request(base)).json()).data.models[0].ceiling,"none");
  assert.equal((await t.post(base+"/task",{...payload,maxAccess:null},a)).status,200);
  assert.equal((await (await t.request(base)).json()).data.models[0].ceiling,null);
  assert.equal((await t.request(base.replace("usr_child","usr_denied"))).status,403);
  assert.ok(t.requests.filter(x=>x.who==="core").every(x=>!x.path.includes("platform-admin")));
});

test("Space settings are explicit current-user operations; no Core request for invalid origin, CSRF, method or target",async()=>{
  const t=setup(),a=await t.auth(),base="/api/account/spaces/"+SPACE;
  const update={intent:"update-space",confirmSpaceId:SPACE,name:"Renamed",timezone:"UTC",version:3};
  const close={intent:"close-space",confirmSpaceId:SPACE,version:4};
  const count=()=>t.requests.filter(x=>x.who==="core").length;
  const before=count();
  assert.equal((await t.request(base+"/close")).status,405);
  assert.equal((await t.post(base+"/close",close,{...a,csrf:"wrong"})).status,403);
  assert.equal((await t.post(base+"/close",close,a,{origin:"https://evil.test"})).status,403);
  assert.equal((await t.post(base+"/close",{...close,confirmSpaceId:created},a)).status,400);
  assert.equal((await t.post(base+"/close",{...close,version:0},a)).status,400);
  assert.equal((await t.post(base+"/close",{...close,actorUserId:USER},a)).status,400);
  assert.equal((await t.post(base+"/update?x=1",update,a)).status,400);
  assert.equal(count(),before);
  const saved=await t.post(base+"/update",update,a);
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).data,{id:SPACE,name:"Renamed",timezone:"UTC",version:4});
  assert.equal((await t.post(base+"/update",update,a)).status,409);
  assert.equal((await t.post(base+"/close",{...close,version:3},a)).status,409);
  assert.equal((await t.post(base+"/leave",{intent:"leave-space",confirmSpaceId:SPACE},a)).status,409);
  assert.equal((await t.post(base+"/close",close,a)).status,200);
  assert.deepEqual((await (await t.request("/api/account/spaces")).json()).data,[]);
  assert.ok(t.requests.some(x=>x.who==="core"&&x.method==="PATCH"&&x.path==="/api/v1/spaces/"+SPACE));
  assert.ok(t.requests.filter(x=>x.who==="core").every(x=>!x.path.includes("platform-admin")));
});
test("Core retains non-owner close denial, manager edit and non-owner leave; failures are not reported as success",async()=>{
  const base="/api/account/spaces/"+SPACE;
  const update={intent:"update-space",confirmSpaceId:SPACE,name:"Renamed",timezone:"UTC",version:3};
  const close={intent:"close-space",confirmSpaceId:SPACE,version:3};
  const leave={intent:"leave-space",confirmSpaceId:SPACE};
  const viewer=setup({spaceRole:"viewer"}),v=await viewer.auth();
  assert.equal((await viewer.post(base+"/update",update,v)).status,403);
  assert.equal((await viewer.post(base+"/close",close,v)).status,403);
  assert.equal((await viewer.post(base+"/leave",leave,v)).status,200);
  const admin=setup({spaceRole:"admin"}),a=await admin.auth();
  assert.equal((await admin.post(base+"/close",close,a)).status,403);
  assert.equal((await admin.post(base+"/update",update,a)).status,200);
  const fault=setup({settingsStatus:500}),f=await fault.auth();
  assert.equal((await fault.post(base+"/close",close,f)).status,503);
  assert.equal((await (await fault.request("/api/account/spaces")).json()).data.length,1);
});
