import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const db = () => (env as unknown as { DB: D1Database }).DB;
const rid = (prefix: string) => prefix + "_" + crypto.randomUUID().replaceAll("-", "");
function pem(label: string, bytes: ArrayBuffer) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function fixture() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const privateKey = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
  const space = rid("spc"), otherSpace = rid("spc");
  const manager = rid("usr"), secondManager = rid("usr"), viewer = rid("usr");
  const appA = rid("app"), appB = rid("app");
  const time = new Date().toISOString();
  const insert = [
    db().prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?)")
      .bind(space, "Synthetic Space", manager, time, time),
    db().prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?)")
      .bind(otherSpace, "Other Space", manager, time, time),
    ...[
      [space, manager, "owner"],
      [space, secondManager, "admin"],
      [space, viewer, "viewer"],
      [otherSpace, manager, "owner"],
    ].map(([s,uid,role])=>db().prepare(
      "INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).bind(rid("mem"), s, uid, role, time, time)),
  ];
  await db().batch(insert);

  async function token(userId = manager, applicationId = appA, scope = "spaces:manage") {
    const now = Math.floor(Date.now() / 1000);
    return sign({ iss:"lifespace-identity",aud:"lifespace-core",sub:userId,
      principal_type:"user",azp:applicationId,scope,
      iat:now,exp:now+600,jti:rid("tok") },privateKey,"RS256");
  }
  async function request(path: string, options: {
    userId?:string,applicationId?:string,scope?:string,method?:string,body?:unknown
  }={}) {
    const bearer = await token(options.userId, options.applicationId, options.scope);
    return createApp().request("https://core.example.com"+path,{
      method:options.method??"GET",
      headers:{authorization:"Bearer "+bearer,...(options.body===undefined?{}:{"content-type":"application/json"})},
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
    },{ DB:db(), IDENTITY_PUBLIC_KEY:publicKey, ENVIRONMENT:"test" });
  }
  async function seed(options: { spaceId?:string,applicationId?:string,ownerType?:"space"|"user",ownerId?:string,
    kind?:"agent"|"service"|"event_push"|"external_data",status?:"pending"|"active" }={}) {
    const id=rid("conn"),s=options.spaceId??space,app=options.applicationId??appA;
    const kind=options.kind??"agent",status=options.status??"pending";
    const ownerType=options.ownerType??"space",ownerId=options.ownerId??s;
    const identityType=kind==="agent"?"agent":kind==="service"?"service":null;
    const identityId=identityType?rid(identityType==="agent"?"agt":"svc"):null;
    const backingType=kind==="event_push"?"webhook_endpoint":kind==="external_data"?"external_provider":null;
    const backingId=backingType?rid(backingType==="webhook_endpoint"?"whk":"cnx"):null;
    await db().prepare(`INSERT INTO unified_connections
      (id,application_id,space_id,kind,name,note,status,owner_type,owner_id,
      identity_type,identity_id,backing_type,backing_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,app,s,kind,"Synthetic integration","Example note",
        status,ownerType,ownerId,identityType,identityId,backingType,backingId,time,time).run();
    return id;
  }
  return {space,otherSpace,manager,secondManager,viewer,appA,appB,seed,request};
}

describe("Unified Connection read-only application self-service boundary",()=>{
  it("only shows matching Application and visible management owner",async()=>{
    const f=await fixture();
    const own=await f.seed();
    await f.seed({applicationId:f.appB});
    await f.seed({ownerType:"user",ownerId:f.secondManager});
    const mine=await f.seed({ownerType:"user",ownerId:f.manager});
    const result=await f.request(`/api/v1/spaces/${f.space}/connections`);
    expect(result.status).toBe(200);
    const data=(await result.json<any>()).data;
    expect(data.items.map((x:{connectionId:string})=>x.connectionId).sort()).toEqual([own,mine].sort());
    expect(JSON.stringify(data)).not.toContain("credential");
    expect(data.items[0]).toHaveProperty("note","Example note");
    const other=await f.request(`/api/v1/spaces/${f.space}/connections`,{applicationId:f.appB});
    expect((await other.json<any>()).data.items).toHaveLength(1);
    const otherUser=await f.request(`/api/v1/spaces/${f.space}/connections`,{userId:f.secondManager});
    expect((await otherUser.json<any>()).data.items).toHaveLength(2);
  });

  it("does not reveal another App, Space or personal Connection by ID",async()=>{
    const f=await fixture();
    const inA=await f.seed();
    const inB=await f.seed({applicationId:f.appB});
    const personal=await f.seed({ownerType:"user",ownerId:f.secondManager});
    for (const [path,options] of [
      [`/api/v1/spaces/${f.space}/connections/${inB}`,{}],
      [`/api/v1/spaces/${f.otherSpace}/connections/${inA}`,{}],
      [`/api/v1/spaces/${f.space}/connections/${personal}`,{}],
      [`/api/v1/spaces/${f.space}/connections/invalid`,{}],
    ] as const) {
      const response=await f.request(path,options);
      expect(response.status).toBe(404);
    }
    const own=await f.request(`/api/v1/spaces/${f.space}/connections/${inA}`);
    expect(own.status).toBe(200);
    expect((await own.json<any>()).data.connectionId).toBe(inA);
  });

  it("requires User, spaces:manage and current Space manage authority",async()=>{
    const f=await fixture();
    await f.seed();
    const path=`/api/v1/spaces/${f.space}/connections`;
    expect((await f.request(path,{scope:"spaces:read"})).status).toBe(403);
    expect((await f.request(path,{userId:f.viewer})).status).toBe(403);
    expect((await f.request(path,{userId:f.secondManager})).status).toBe(200);
  });

  it("bounds and validates pagination and rejects arbitrary filtering",async()=>{
    const f=await fixture();
    await f.seed();await f.seed();await f.seed();
    const first=await f.request(`/api/v1/spaces/${f.space}/connections?limit=2&offset=0`);
    expect(first.status).toBe(200);
    expect((await first.json<any>()).data.nextOffset).toBe(2);
    const second=await f.request(`/api/v1/spaces/${f.space}/connections?limit=2&offset=2`);
    expect(second.status).toBe(200);
    expect((await second.json<any>()).data.nextOffset).toBeNull();
    for(const q of ["limit=0","limit=51","limit=01","limit=1&limit=2","offset=-1","applicationId=app_other"]) {
      expect((await f.request(`/api/v1/spaces/${f.space}/connections?${q}`)).status).toBe(400);
    }
    expect((await f.request(`/api/v1/spaces/${f.space}/connections`,{method:"POST"})).status).toBe(415);
  });
});


describe("Unified Connection pending draft lifecycle",()=>{
  it("creates a pending draft under verified Application and Space without identity or credentials",async()=>{
    const f=await fixture();
    const path=`/api/v1/spaces/${f.space}/connections`;
    const response=await f.request(path,{method:"POST",body:{
      kind:"agent",name:"  Household n8n agent  ",note:"Initial note",ownerType:"user",
    }});
    expect(response.status,JSON.stringify(await response.clone().json())).toBe(201);
    const data=(await response.json<any>()).data;
    expect(data.connectionId).toMatch(/^conn_[a-f0-9]{32}$/u);
    expect(data.applicationId).toBe(f.appA);
    expect(data.spaceId).toBe(f.space);
    expect(data.kind).toBe("agent");
    expect(data.status).toBe("pending");
    expect(data.name).toBe("Household n8n agent");
    expect(data.note).toBe("Initial note");
    expect(data.owner).toEqual({type:"user",id:f.manager});
    expect(data).not.toHaveProperty("identity");
    const raw=await db().prepare("SELECT * FROM unified_connections WHERE id=?")
      .bind(data.connectionId).first<any>();
    expect(raw.application_id).toBe(f.appA);
    expect(raw.identity_id).toBeNull();
    expect(raw.backing_id).toBeNull();
    expect(raw.status).toBe("pending");
    expect(Object.keys(raw)).not.toContain("credential");
    const listed=await f.request(path);
    expect((await listed.json<any>()).data.items[0].connectionId).toBe(data.connectionId);
  });

  it("prevents selecting Application, Space, Identity, owner ID, active status or injected credentials",async()=>{
    const f=await fixture();
    const path=`/api/v1/spaces/${f.space}/connections`;
    for(const body of [
      {kind:"agent",name:"X",applicationId:f.appB},
      {kind:"agent",name:"X",spaceId:f.otherSpace},
      {kind:"agent",name:"X",status:"active"},
      {kind:"service",name:"X",identityId:rid("svc")},
      {kind:"event_push",name:"X",backingId:rid("whk")},
      {kind:"agent",name:"X",ownerType:"user",ownerId:f.secondManager},
      {kind:"agent",name:"X",credential:"synthetic-not-a-token"},
      {kind:"agent",name:"X",ownerType:"admin"},
      {kind:"agent",name:""},
      {kind:"invalid",name:"X"},
      {kind:"agent",name:"X",note:"x".repeat(1001)},
    ]) {
      const response=await f.request(path,{method:"POST",body});
      expect(response.status,JSON.stringify({body,payload:await response.clone().text()})).toBe(400);
    }
    expect((await f.request(path,{method:"POST",scope:"spaces:read",body:{kind:"service",name:"X"}})).status).toBe(403);
    expect((await f.request(path,{method:"POST",userId:f.viewer,body:{kind:"service",name:"X"}})).status).toBe(403);
    const rows=await db().prepare("SELECT COUNT(*) cnt FROM unified_connections WHERE application_id=?")
      .bind(f.appA).first<{cnt:number}>();
    expect(rows?.cnt).toBe(0);
  });

  it("edits only name/note with optimistic updatedAt and preserves immutable boundaries",async()=>{
    const f=await fixture();
    const path=`/api/v1/spaces/${f.space}/connections`;
    const created=await f.request(path,{method:"POST",body:{kind:"service",name:"n8n Service"}});
    const initial=(await created.json<any>()).data;
    const id=initial.connectionId;
    const first=await f.request(`${path}/${id}`,{method:"PATCH",body:{
      name:"n8n HomeMew Service",note:"Rotating manually",expectedUpdatedAt:initial.updatedAt,
    }});
    expect(first.status,JSON.stringify(await first.clone().json())).toBe(200);
    const next=(await first.json<any>()).data;
    expect(next.name).toBe("n8n HomeMew Service");
    expect(next.note).toBe("Rotating manually");
    expect(next.updatedAt).not.toBe(initial.updatedAt);
    expect(next.applicationId).toBe(f.appA);
    expect(next.owner).toEqual(initial.owner);
    const stale=await f.request(`${path}/${id}`,{method:"PATCH",body:{
      note:"Stale write",expectedUpdatedAt:initial.updatedAt,
    }});
    expect(stale.status).toBe(409);
    const forged=await f.request(`${path}/${id}`,{method:"PATCH",body:{
      status:"active",expectedUpdatedAt:next.updatedAt,
    }});
    expect(forged.status).toBe(400);
    const clear=await f.request(`${path}/${id}`,{method:"PATCH",body:{
      note:null,expectedUpdatedAt:next.updatedAt,
    }});
    expect(clear.status).toBe(200);
    expect((await clear.json<any>()).data).not.toHaveProperty("note");
    expect((await db().prepare("SELECT status,identity_id FROM unified_connections WHERE id=?")
      .bind(id).first<any>())).toEqual({status:"pending",identity_id:null});
  });

  it("cannot edit other Application/Space/user-owned connection or bypass role",async()=>{
    const f=await fixture();
    const appB=await f.seed({applicationId:f.appB});
    const userOwned=await f.seed({ownerType:"user",ownerId:f.secondManager});
    const otherSpace=await f.seed({spaceId:f.otherSpace});
    for(const id of [appB,userOwned]) {
      const response=await f.request(`/api/v1/spaces/${f.space}/connections/${id}`,{
        method:"PATCH",body:{name:"No",expectedUpdatedAt:new Date().toISOString()},
      });
      expect(response.status).toBe(404);
    }
    expect((await f.request(`/api/v1/spaces/${f.space}/connections/${otherSpace}`,{
      method:"PATCH",body:{name:"No"},
    })).status).toBe(404);
    const path=`/api/v1/spaces/${f.space}/connections`;
    const created=await f.request(path,{method:"POST",body:{kind:"agent",name:"Safe"}});
    const data=(await created.json<any>()).data;
    for(const options of [{userId:f.viewer},{scope:"spaces:read"}]) {
      expect((await f.request(`${path}/${data.connectionId}`,{...options,method:"PATCH",
        body:{name:"No",expectedUpdatedAt:data.updatedAt}})).status).toBe(403);
    }
  });

  it("can cancel only an unprovisioned draft, leaving a terminal revoked audit row",async()=>{
    const f=await fixture();
    const path=`/api/v1/spaces/${f.space}/connections`;
    const created=await f.request(path,{method:"POST",body:{kind:"event_push",name:"Test webhook"}});
    const data=(await created.json<any>()).data;
    const cancelled=await f.request(`${path}/${data.connectionId}`,{method:"DELETE"});
    expect(cancelled.status).toBe(204);
    const row=await db().prepare("SELECT status,revoked_at,identity_id,backing_id FROM unified_connections WHERE id=?")
      .bind(data.connectionId).first<any>();
    expect(row.status).toBe("revoked");
    expect(row.revoked_at).toBeTruthy();
    expect((await f.request(`${path}/${data.connectionId}`,{method:"DELETE"})).status).toBe(409);
    expect((await f.request(`${path}/${data.connectionId}`,{method:"PATCH",
      body:{note:"Cannot revive",expectedUpdatedAt:data.updatedAt}})).status).toBe(409);
    const provisioned=await f.seed();
    expect((await f.request(`${path}/${provisioned}`,{method:"DELETE"})).status).toBe(409);
    const active=await f.seed({status:"active"});
    expect((await f.request(`${path}/${active}`,{method:"DELETE"})).status).toBe(409);
  });
});
