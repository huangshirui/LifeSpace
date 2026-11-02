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
    userId?:string,applicationId?:string,scope?:string,method?:string
  }={}) {
    const bearer = await token(options.userId, options.applicationId, options.scope);
    return createApp().request("https://core.example.com"+path,{
      method:options.method??"GET",headers:{authorization:"Bearer "+bearer},
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
    expect((await f.request(`/api/v1/spaces/${f.space}/connections`,{method:"POST"})).status).toBe(404);
  });
});
