import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { evaluateModelAccessMany, requireModelAccess } from "../src/model-authorization";
import { modelAccessWithinCeiling } from "../src/model-access-ceiling";
import { getRuntimeModel } from "../src/model-registry";
import { visibleModelAccess } from "../src/runtime-discovery";

describe("Model Access Ceiling V1", () => {
  it("only narrows access, preserves trusted owner and handles absence", () => {
    expect(modelAccessWithinCeiling("editor", null, "write")).toBe(true);
    expect(modelAccessWithinCeiling("editor", "none", "read")).toBe(false);
    expect(modelAccessWithinCeiling("editor", "read", "read")).toBe(true);
    expect(modelAccessWithinCeiling("editor", "read", "write")).toBe(false);
    expect(modelAccessWithinCeiling(null, "write", "manage")).toBe(false);
    expect(modelAccessWithinCeiling("owner", "none", "manage")).toBe(true);
  });

  it("bounds both membership and positive grants without new authority RTT; restores inheritance", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const bindings = { DB: db } as Bindings;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_ceiling_${suffix}`;
    const agentId = `agt_ceiling_${suffix}`;
    const ownerId = `usr_owner_${suffix}`;
    const spaceId = `spc_ceiling_${suffix}`;
    const clientId = `app_ceiling_${suffix}`;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(spaceId,"Ceiling",ownerId,now,now,"UTC"),
      db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(`mem_${suffix}`,spaceId,userId,"editor",now,now),
      db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)").bind(clientId,"task","write","user",ownerId),
      db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(`grt_${suffix}`,spaceId,"user",userId,"space",null,"write",ownerId,now),
      db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(`grt_agent_${suffix}`,spaceId,"agent",agentId,"model","task","write",ownerId,now),
    ]);
    const task = await getRuntimeModel(bindings,"task");
    if (!task) throw new Error("task missing");
    const user: Principal = { type:"user",id:userId,clientId,scopes:["resources:read","resources:write"],tokenId:`tok_${suffix}` };
    const agent: Principal = { ...user,type:"agent",id:agentId,tokenId:`tok_agent_${suffix}` };
    const set = (ceiling: "none" | "read" | "manage") => db.prepare(`INSERT INTO model_access_ceilings
      (space_id,entity_type,entity_id,model_key,max_access,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES(?,'user',?,?,?,?,?,?,?) ON CONFLICT(space_id,entity_type,entity_id,model_key)
      DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`)
      .bind(spaceId,userId,"task",ceiling,ownerId,ownerId,now,now).run();

    expect((await requireModelAccess(bindings,user,spaceId,task,"write")).authority.spaceAuthority).toBe("editor");
    await set("read");
    const samples: number[] = [];
    const results = await evaluateModelAccessMany(bindings,user,spaceId,Array.from({ length:20 },(_,i)=>({
      model:task,required:i===0?"read" as const:"write" as const,
      selector:{recordId:`rec_${i}`},observeAuthorityBatch: sample => samples.push(sample.statements),
    })));
    expect(samples).toEqual([1]);
    expect(results[0]?.ok).toBe(true);
    expect(results.slice(1).every(r=>!r.ok && r.error.status===403)).toBe(true);
    const delegationId = `dlg_${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at,parent_delegation_id,remaining_redelegation_depth
      ) VALUES(?,'user',?,'agent',?,?,?,?,?,?,?,?)`)
        .bind(delegationId,userId,agentId,clientId,spaceId,"user",userId,now,null,0),
      db.prepare(`INSERT INTO delegation_scopes(delegation_id,target_type,target_id,target_model_key,max_access)
        VALUES(?,'model','task','task','write')`).bind(delegationId),
    ]);
    const represented: Principal = {...user,actor:{type:"agent",id:agentId},purpose:"agent_execution"};
    const opaqueAgent: Principal = {...agent,purpose:"agent_api"};
    const selector = {delegationId};
    expect((await requireModelAccess(bindings,represented,spaceId,task,"read",selector)).principal.id).toBe(userId);
    await expect(requireModelAccess(bindings,represented,spaceId,task,"write",selector)).rejects.toMatchObject({status:403});
    expect((await requireModelAccess(bindings,opaqueAgent,spaceId,task,"read",selector)).principal.id).toBe(userId);
    await expect(requireModelAccess(bindings,opaqueAgent,spaceId,task,"write",selector)).rejects.toMatchObject({status:403});
    await set("none");
    await expect(requireModelAccess(bindings,user,spaceId,task,"read")).rejects.toMatchObject({status:403});
    await expect(requireModelAccess(bindings,represented,spaceId,task,"read",selector)).rejects.toMatchObject({status:403});
    await expect(requireModelAccess(bindings,opaqueAgent,spaceId,task,"read",selector)).rejects.toMatchObject({status:403});
    expect((await requireModelAccess(bindings,agent,spaceId,task,"write")).authority.spaceAuthority).toBe("grant");

    // Independent User grant survives membership removal, but the ceiling does too.
    await db.prepare("UPDATE space_memberships SET deleted_at=? WHERE space_id=? AND user_id=?").bind(now,spaceId,userId).run();
    await expect(requireModelAccess(bindings,user,spaceId,task,"read")).rejects.toMatchObject({status:403});
    await db.prepare("DELETE FROM model_access_ceilings WHERE space_id=? AND entity_type='user' AND entity_id=? AND model_key='task'").bind(spaceId,userId).run();
    expect((await requireModelAccess(bindings,user,spaceId,task,"write")).authority.spaceAuthority).toBe("grant");

    // A higher ceiling never supplies authority absent from both sources.
    await db.prepare("UPDATE data_grants SET permission='read' WHERE grantee_type='user' AND grantee_id=?").bind(userId).run();
    await set("manage");
    await expect(requireModelAccess(bindings,user,spaceId,task,"write")).rejects.toMatchObject({status:403});
    expect((await requireModelAccess(bindings,user,spaceId,task,"read")).authority.spaceAuthority).toBe("grant");
  });

  it("filters Native runtime discovery consistently without elevating role authority", async () => {
    const bindings = { DB:(env as unknown as { DB:D1Database }).DB } as Bindings;
    const task = await getRuntimeModel(bindings,"task");
    if (!task) throw new Error("task missing");
    const user: Principal = {type:"user",id:"usr_ceiling_discovery",clientId:"app_ceiling_discovery",scopes:["resources:read","resources:write"],tokenId:"tok_ceiling_discovery"};
    const catalog = new Map([["task","write" as const]]);
    const grants = [{resource_type:"model" as const,resource_id:"task",permission:"write" as const}];
    expect(visibleModelAccess(user,[task],catalog,{role:"editor"},grants,undefined,new Map([["task","none" as const]]))).toEqual([]);
    expect(visibleModelAccess(user,[task],catalog,{role:"editor"},grants,undefined,new Map([["task","read" as const]]))[0]?.access).toEqual(["read"]);
    expect(visibleModelAccess(user,[task],catalog,{role:"viewer"},[],undefined,new Map([["task","manage" as const]]))[0]?.access).toEqual(["read"]);
  });
});
