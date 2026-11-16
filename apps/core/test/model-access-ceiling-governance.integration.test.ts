import { env } from "cloudflare:workers";
import { describe,expect,it } from "vitest";
import type { Bindings,Principal } from "../src/env";
import { changeModelAccessCeiling,listModelAccessCeilings,type CeilingManager } from "../src/model-access-ceiling-governance";
import { countingDatabase,type DatabaseCost } from "./support/counting-database";

describe("Model Access Ceiling governance",()=>{
  it("requires current real roles, preserves dormant restrictions and audits every accepted change",async()=>{
    const db=(env as unknown as {DB:D1Database}).DB, bindings={DB:db} as Bindings;
    const suffix=crypto.randomUUID().replaceAll("-","");
    const spaceId="spc_"+suffix, now=new Date().toISOString();
    const ids={owner:"usr_owner_"+suffix,admin:"usr_admin_"+suffix,peer:"usr_peer_"+suffix,editor:"usr_editor_"+suffix,viewer:"usr_viewer_"+suffix,grantee:"usr_grantee_"+suffix};
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(spaceId,"Ceiling governance",ids.owner,now,now,"UTC"),
      ...(["owner","admin","peer","editor","viewer"] as const).map(key=>db.prepare(
        "INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind("mem_"+key+"_"+suffix,spaceId,ids[key],key==="peer"?"admin":key,now,now)),
      db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind("grt_"+suffix,spaceId,"user",ids.grantee,"space",null,"manage",ids.owner,now),
    ]);
    const principal=(id:string):Principal=>({type:"user",id,clientId:"app_"+suffix,scopes:["spaces:manage"],tokenId:"tok_"+suffix});
    const manager=(id:string):CeilingManager=>({kind:"space",principal:principal(id)});
    const target=(userId:string)=>({spaceId,userId});
    const change=(who:string,to:string,value:"none"|"read"|null)=>changeModelAccessCeiling(bindings,manager(who),target(to),"task",value,"req_"+suffix);
    await expect(change(ids.editor,ids.viewer,"none")).rejects.toMatchObject({status:403});
    await expect(change(ids.grantee,ids.editor,"none")).rejects.toMatchObject({status:403});
    await expect(change(ids.admin,ids.peer,"none")).rejects.toMatchObject({status:403});
    await expect(change(ids.admin,ids.admin,"none")).rejects.toMatchObject({status:403});
    await expect(change(ids.admin,ids.owner,"none")).rejects.toMatchObject({status:403});
    await expect(changeModelAccessCeiling(bindings,{kind:"space",principal:{...principal(ids.owner),actor:{type:"agent",id:"agt_other"}}},target(ids.editor),"task","none","req")).rejects.toMatchObject({status:403});
    await change(ids.admin,ids.editor,"none");
    await change(ids.owner,ids.editor,"read");
    expect(await listModelAccessCeilings(bindings,manager(ids.owner),target(ids.editor))).toMatchObject([{modelKey:"task",maxAccess:"read"}]);
    await db.prepare("UPDATE space_memberships SET deleted_at=? WHERE space_id=? AND user_id=?").bind(now,spaceId,ids.editor).run();
    await expect(change(ids.admin,ids.editor,null)).rejects.toMatchObject({status:403});
    await change(ids.owner,ids.editor,null);
    const evidence=await db.prepare("SELECT previous_access,next_access,actor_user_id FROM model_access_ceiling_audit WHERE space_id=? ORDER BY rowid").bind(spaceId).all();
    expect(evidence.results).toEqual([
      {previous_access:null,next_access:"none",actor_user_id:ids.admin},
      {previous_access:"none",next_access:"read",actor_user_id:ids.owner},
      {previous_access:"read",next_access:null,actor_user_id:ids.owner},
    ]);
    // Commit-time recheck blocks a concurrently demoted manager.
    const cost:DatabaseCost={roundTrips:0,rowsRead:0,sql:[]};
    let changed=false;
    const wrapped=countingDatabase(db,cost,async statements=>{
      if(!changed && statements.some(sql=>sql.includes("INSERT INTO model_access_ceiling_audit"))){
        changed=true;
        await db.prepare("UPDATE space_memberships SET role='editor' WHERE space_id=? AND user_id=?").bind(spaceId,ids.admin).run();
      }
    });
    await expect(changeModelAccessCeiling({...bindings,DB:wrapped},manager(ids.admin),target(ids.viewer),"task","none","race")).rejects.toMatchObject({status:403});
    expect(changed).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) n FROM model_access_ceiling_audit WHERE space_id=?").bind(spaceId).first<{n:number}>())?.n).toBe(3);
    const admin:CeilingManager={kind:"platform",admin:{
      actor:{...principal(ids.owner),type:"user"},
      executor:{...principal("svc_"+suffix),type:"service"},
    }};
    await changeModelAccessCeiling(bindings,admin,target(ids.viewer),"task","none","platform_request");
    expect(await listModelAccessCeilings(bindings,admin,target(ids.viewer))).toMatchObject([{modelKey:"task",maxAccess:"none"}]);
    expect((await db.prepare("SELECT actor_user_id,executor_principal_id FROM platform_admin_audit WHERE request_id=?").bind("platform_request").first())).toMatchObject({actor_user_id:ids.owner,executor_principal_id:"svc_"+suffix});
  });
});
