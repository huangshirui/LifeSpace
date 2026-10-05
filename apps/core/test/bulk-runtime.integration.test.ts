import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign","verify"]);
  return { privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)) };
}
async function token(privateKey: string, userId: string, agentId?: string) {
  const iat = Math.floor(Date.now()/1000);
  return sign({ iss:"lifespace-identity", aud:"lifespace-core", sub:agentId ?? userId, azp:"bulk-test-app", principal_type:"user", scope:"resources:read resources:write", iat, exp:iat+900, jti:`tok_${crypto.randomUUID()}`, ...(agentId ? { principal_id:userId, actor_type:"agent", actor_id:agentId, purpose:"agent_execution" } : {}) }, privateKey, "RS256");
}
async function request(publicKey:string, bearer:string, path:string, body:unknown) {
  return createApp().request(`http://localhost${path}`, { method:"POST", headers:{ authorization:`Bearer ${bearer}`, "content-type":"application/json" }, body:JSON.stringify(body) }, { DB:(env as unknown as TestEnv).DB, IDENTITY_PUBLIC_KEY:publicKey, ENVIRONMENT:"test" });
}
async function json(response:Response) { return response.json<any>(); }
async function seed(userId:string, spaceId:string) {
  const db=(env as unknown as TestEnv).DB; const now=new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(spaceId,"Bulk",userId,now,now,"UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(`mem_${crypto.randomUUID()}`,spaceId,userId,"owner",now,now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(`per_${crypto.randomUUID()}`,spaceId,userId,"Owner",now,now),
    db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?) ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access").bind("bulk-test-app","task","write","user",userId),
  ]);
}
async function createTask(publicKey:string,bearer:string,spaceId:string,name:string) {
  const r=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/task/records`,{name,assigneePersonIds:[]}); expect(r.status).toBe(201); return (await json(r)).data;
}
async function delegation(publicKey:string,direct:string,spaceId:string,agentId:string) {
  const r=await request(publicKey,direct,`/api/v1/spaces/${spaceId}/delegations`,{actor:{type:"agent",id:agentId},scope:{target:{type:"model",id:"task"},maxAccess:"write"},constraints:{maxUses:1}}); expect(r.status).toBe(201); return (await json(r)).data.id as string;
}

describe("first-class non-atomic Bulk Runtime",()=>{
  it("keeps successful items when another item is invalid or stale",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const bearer=await token(privateKey,userId); const target=await createTask(publicKey,bearer,spaceId,"old");
    const response=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:[
      {operation:"create",modelKey:"task",data:{name:"good",assigneePersonIds:[]}},
      {operation:"update",modelKey:"task",recordId:target.id,version:999999,data:{name:"stale"}},
      {operation:"create",modelKey:"missing_model",data:{name:"bad"}},
    ]});
    expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.bulkId).toMatch(/^blk_/); expect(result.items.map((x:any)=>x.status)).toEqual(["succeeded","failed","failed"]); expect(result.items[1].error.code).toBe("VERSION_CONFLICT"); expect(result.items[2].error.code).toBe("MODEL_NOT_FOUND");
    const db=(env as unknown as TestEnv).DB; const changes=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); const bulk=await db.prepare("SELECT operation_count,succeeded_count,failed_count,completed_at FROM resource_bulk_requests WHERE id=?").bind(result.bulkId).first<any>(); expect(changes?.count).toBe(1); expect(bulk).toMatchObject({operation_count:3,succeeded_count:1,failed_count:2}); expect(bulk.completed_at).toBeTruthy();
  });

  it("commits 20 valid creates in one explicit Bulk identity",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const bearer=await token(privateKey,userId);
    const response=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:Array.from({length:20},(_,i)=>({operation:"create",modelKey:"task",data:{name:`Bulk ${i}`,assigneePersonIds:[]}}))}); expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.items).toHaveLength(20); expect(result.items.every((x:any)=>x.status==="succeeded")).toBe(true); const db=(env as unknown as TestEnv).DB; const count=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); expect(count?.count).toBe(20);
  });

  it("consumes a shared single-use Delegation for only one successful item",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const agentId=`agt_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const direct=await token(privateKey,userId); const represented=await token(privateKey,userId,agentId); const dlg=await delegation(publicKey,direct,spaceId,agentId);
    const response=await request(publicKey,represented,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:[
      {operation:"create",modelKey:"task",delegationId:dlg,data:{name:"winner",assigneePersonIds:[]}},
      {operation:"create",modelKey:"task",delegationId:dlg,data:{name:"loser",assigneePersonIds:[]}},
    ]}); expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.items.filter((x:any)=>x.status==="succeeded")).toHaveLength(1); expect(result.items.filter((x:any)=>x.status==="failed")).toHaveLength(1); const db=(env as unknown as TestEnv).DB; const changes=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); expect(changes?.count).toBe(1);
  });
});
