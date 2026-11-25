import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { publishModelDefinition } from "../src/model-registry";
import { createGenericResource } from "../src/generic-resource";
import type { Bindings, Principal } from "../src/env";
import { oauthExecutionRouteAllowed, verifyAccessToken } from "../src/auth";

type TestEnv = { DB: D1Database; ASSETS: R2Bucket };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer) {
  return "-----BEGIN " + label + "-----\n"
    + (btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/g) || []).join("\n")
    + "\n-----END " + label + "-----";
}

async function fixture() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const key = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
  const uuid = crypto.randomUUID().replaceAll("-", "");
  const agent = "agt_" + uuid;
  const application = "app_" + uuid;
  const space = "spc_" + uuid;
  const other = "spc_other_" + uuid;
  const authId = "oaz_" + uuid;
  const oauthUser = "usr_" + uuid;
  const client = "ocli_" + uuid;
  const accountApp = "app_account_" + uuid;
  const tokenHash = "a".repeat(64);
  const serverId = "mcp_" + uuid;
  const resource = "https://resource.example.test/mcp/" + serverId;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "lifespace-identity", aud: "lifespace-core",
    sub: agent, azp: application, principal_type: "agent", principal_id: agent,
    actor_type: "agent", actor_id: agent, purpose: "oauth_agent_execution",
    scope: "resources:read", oauth_authorization_id: authId,
    oauth_access_hash: tokenHash, oauth_client_id: client,
    oauth_resource: resource, oauth_space_id: space,
    oauth_user_id: oauthUser, oauth_allow_user_authorization: false,
    iat: now, exp: now + 50, jti: "tok_" + uuid,
  };
  const db = (env as unknown as TestEnv).DB;
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO mcp_server_definitions(id,display_name,description,enabled,config_json,revision,created_by_user_id,updated_by_user_id,created_at,updated_at) VALUES(?,?,?,1,?,1,?,?,?,?)")
      .bind(serverId, "Synthetic OAuth MCP Server", "",
        JSON.stringify({ models: [{ modelKey: "task", operations: ["query"] }] }),
        "usr_synthetic", "usr_synthetic", timestamp, timestamp),
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(space, "Authorized OAuth Space", "usr_synthetic", timestamp, timestamp, "UTC"),
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(other, "Other Agent Grant Space", "usr_synthetic", timestamp, timestamp, "UTC"),
    db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?, 'agent',?, 'space',NULL,'read',?,?)")
      .bind("grt_" + uuid, space, agent, "usr_synthetic", timestamp),
    db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?, 'agent',?, 'space',NULL,'read',?,?)")
      .bind("grt_other_" + uuid, other, agent, "usr_synthetic", timestamp),
    db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)")
      .bind(application, "task", "read", "service", "svc_synthetic"),
  ]);
  // Count actual base-authority SQL preparations and binding round trips,
  // not mock elapsed time. The unwrapped DB is retained for fixture writes.
  let authorityStatements=0, pendingAuthorityStatements=0;
  const authorityBatches:number[]=[];
  const countedDb=new Proxy(db,{
    get(target,property){
      if(property==="prepare")return (sql:string)=>{
        if(sql.includes("AS catalog_access")&&sql.includes("AS membership_role")){
          authorityStatements++;pendingAuthorityStatements++;
        }
        return db.prepare(sql);
      };
      if(property==="batch")return (statements:D1PreparedStatement[])=>{
        if(pendingAuthorityStatements){
          authorityBatches.push(pendingAuthorityStatements);
          pendingAuthorityStatements=0;
        }
        return db.batch(statements);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    },
  });
  let active = true, checks = 0, lastBody: unknown;
  let delegationEnabled = false;
  let consentScopes = ["resources:read"];
  const bindings = {
    ENVIRONMENT: "staging", DB: countedDb, ASSETS: (env as unknown as TestEnv).ASSETS, IDENTITY_PUBLIC_KEY: publicKey,
    CORE_IDENTITY_SHARED_SECRET: "synthetic-core-to-identity-shared-secret",
    OAUTH_ACCOUNT_APPLICATION_ID: accountApp,
    R2_S3_ACCOUNT_ID: "synthetic-account", R2_S3_ACCESS_KEY_ID: "synthetic-access-key",
    R2_S3_SECRET_ACCESS_KEY: "synthetic-secret-key", R2_S3_BUCKET: "synthetic-files",
    IDENTITY: { fetch: async (url: string, init: RequestInit) => {
      checks++;
      const pathname = new URL(url).pathname;
      if(pathname==="/introspection/v1/agent-credentials"){
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer lsp_agt_synthetic");
        return Response.json({data:{active:true,audience:"lifespace-core",principal:{type:"agent",id:agent,clientId:application,tokenId:"agc_synthetic",purpose:"agent_api",scopes:["resources:read","resources:write"]}}});
      }
      expect(["/introspection/v1/oauth-executions",
        "/introspection/v1/oauth-delegation-authorizations"]).toContain(pathname);
      expect(new Headers(init.headers).get("x-lifespace-internal-secret"))
        .toBe("synthetic-core-to-identity-shared-secret");
      lastBody = JSON.parse(String(init.body));
      return Response.json({ data: {
        active: active && (pathname !== "/introspection/v1/oauth-delegation-authorizations"
          || delegationEnabled), scopes: consentScopes, userId: oauthUser,
        allowUserAuthorization: delegationEnabled,
      } });
    } },
  };
  const jwt = (patch: Record<string, unknown> = {}) => sign({ ...claims, ...patch }, key, "RS256");
  const request = async (method: string, path: string, patch: Record<string, unknown> = {}, body?: unknown,
    extraHeaders: Record<string,string> = {}) => {
    const bearer = await jwt(patch);
    return createApp().request("http://localhost" + path, {
      method, headers: {
        authorization: "Bearer " + bearer,
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, bindings);
  };
  const trustedAgentToken = () => sign({
    iss:"lifespace-identity",aud:"lifespace-core",sub:agent,azp:application,
    principal_type:"agent",principal_id:agent,actor_type:"agent",actor_id:agent,
    purpose:"agent_execution",scope:"resources:read resources:write",
    iat:now,exp:now+600,jti:"tok_trusted_"+uuid,
  },key,"RS256");
  const trustedRequest = async (method:string,path:string,body?:unknown) =>
    createApp().request("http://localhost"+path,{
      method,headers:{authorization:"Bearer "+await trustedAgentToken(),
        ...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    },bindings);
  const opaqueAgentRequest=async(method:string,path:string,selector:string,body?:unknown)=>
    createApp().request("http://localhost"+path,{method,
      headers:{authorization:"Bearer lsp_agt_synthetic","x-lifespace-delegation-id":selector,
        ...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})},bindings);
  const accountToken = (userId = oauthUser) => sign({
    iss: "lifespace-identity", aud: "lifespace-core", sub: userId,
    azp: accountApp, principal_type: "user", scope: "profile:read spaces:read spaces:manage",
    iat: now, exp: now + 600, jti: "tok_account_" + uuid,
  }, key, "RS256");
  const accountRequest = async (method:string,path:string,body?:unknown,userId=oauthUser) =>
    createApp().request("http://localhost"+path,{
      method, headers:{authorization:"Bearer "+await accountToken(userId),
        ...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    },bindings);
  return {
    agent, application, space, other, claims, jwt, request, publicKey, serverId,
    accountRequest, trustedRequest, opaqueAgentRequest, oauthUser, accountApp, authId, client, resource,
    db, setConsentScopes: (v: string[]) => { consentScopes = v; },
    setDelegationEnabled: (enabled: boolean) => { delegationEnabled = enabled; },
    setEnvironment: (v: string) => { bindings.ENVIRONMENT = v; },
    setActive: (value: boolean) => { active = value; },
    setServerEnabled: async (enabled: boolean) => {
      await db.prepare("UPDATE mcp_server_definitions SET enabled=? WHERE id=?")
        .bind(enabled ? 1 : 0, serverId).run();
    },
    setServerOperations: async (operations: string[]) => {
      await db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
        .bind(JSON.stringify({ models: [{ modelKey: "task", operations }] }), serverId).run();
    },
    checks: () => checks, lastBody: () => lastBody,
    resetAuthorityMetrics:()=>{authorityStatements=0;pendingAuthorityStatements=0;authorityBatches.length=0;},
    authorityMetrics:()=>({statements:authorityStatements,batches:[...authorityBatches]}),
  };
}

describe("OAuth MCP Agent Direct execution: Core fail-closed route and Space boundary", () => {
  it("accepts only inventory, selected-Space semantic detail and read-only canonical query", () => {
    const sp = "spc_synthetic";
    expect(oauthExecutionRouteAllowed("GET", "/api/v1/me/_discovery/inventory", sp)).toBe(true);
    expect(oauthExecutionRouteAllowed("GET", "/api/v1/spaces/" + sp + "/_discovery/models/task", sp)).toBe(true);
    expect(oauthExecutionRouteAllowed("GET", "/api/v1/spaces/" + sp + "/models/task/records/rec_synthetic", sp)).toBe(true);
    expect(oauthExecutionRouteAllowed("POST", "/api/v1/spaces/" + sp + "/models/task/records/query", sp)).toBe(true);
    expect(oauthExecutionRouteAllowed("POST", "/api/v1/spaces/" + sp + "/_discovery/models/batch", sp)).toBe(true);
    for (const [method, path] of [
      ["GET", "/api/v1/me/spaces"],
      ["GET", "/api/v1/me/_discovery"],
      ["GET", "/api/v1/spaces/spc_other/_discovery/models/task"],
      ["POST", "/api/v1/spaces/spc_other/models/task/records/query"],
      ["POST", "/api/v1/spaces/spc_other/_discovery/models/batch"],
      ["POST", "/api/v1/spaces/" + sp + "/models/task/records"],
      ["DELETE", "/api/v1/spaces/" + sp + "/models/task/records/x"],
      ["GET", "/api/v1/spaces/" + sp + "/members"],
      ["GET", "/api/v1/platform-admin/spaces"],
      ["GET", "/api/v1/spaces/" + sp + "/_discovery/models/../members"],
    ]) expect(oauthExecutionRouteAllowed(method, path, sp)).toBe(false);
  });

  it("reads only the exact linked native File via an explicitly exposed operation, including represented once-only authority", async () => {
    const f=await fixture();
    const suffix=crypto.randomUUID().replaceAll("-","");
    const modelKey="oauth_file_"+suffix.slice(0,12);
    const fileId="fil_"+suffix;
    const now=new Date().toISOString();
    const bindings={DB:f.db} as Bindings;
    const publisher:Principal={type:"service",id:"svc_"+suffix,clientId:"lifespace-platform-admin",scopes:["models:manage"],tokenId:"tok_publish_"+suffix};
    const model=await publishModelDefinition(bindings,publisher,{
      definitionVersion:1,key:modelKey,
      display:{singular:"Synthetic File holder",plural:"Synthetic File holders"},
      fields:{attachment:{type:"file",nullable:true},otherAttachment:{type:"file",nullable:true},label:{type:"string",nullable:true}},
      access:["read","write"],
    },"initial");
    await f.db.batch([
      f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)")
        .bind(f.application,modelKey,"read","service",publisher.id),
      f.db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(fileId,f.space,"synthetic.pdf","application/pdf",12,"files/"+f.space+"/"+fileId,"ready",f.application,"user",f.oauthUser,"user",f.oauthUser,now),
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+suffix,f.space,f.oauthUser,now,now),
    ]);
    const owner:Principal={type:"user",id:f.oauthUser,clientId:f.application,scopes:["resources:read","resources:write"],tokenId:"tok_owner_"+suffix};
    const record=await createGenericResource(bindings,owner,f.space,model,{attachment:fileId,otherAttachment:null,label:"Synthetic report"});
    const base="/api/v1/spaces/"+f.space;
    const route=base+"/models/"+modelKey+"/records/"+record.id+"/file-downloads";
    const payload={fieldKey:"attachment",fileId};
    const configure=async(operations:string[])=>f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
      .bind(JSON.stringify({models:[{modelKey,operations}]}),f.serverId).run();
    await configure(["get"]);
    expect((await f.request("POST",route,{},payload)).status).toBe(403);
    await configure(["get","file_read"]);
    expect((await f.request("POST",base+"/file-downloads",{},{modelKey,recordId:record.id,...payload})).status).toBe(403);
    expect((await f.request("POST",route.replace(f.space,f.other),{},payload)).status).toBe(403);
    expect((await f.request("POST",route,{}, {...payload,modelKey})).status).toBe(400);
    expect((await f.request("POST",route,{}, {...payload,fieldKey:"otherAttachment"})).status).toBe(404);
    expect((await f.request("POST",route,{}, {...payload,fieldKey:"label"})).status).toBe(404);
    const discovered=await f.request("GET",base+"/_discovery/operations?modelKey="+modelKey+"&operation=file_read");
    expect(discovered.status).toBe(200);
    const listing=await discovered.json() as {data:{operations:Array<{operation:string;operationRef:string;requiredScopes:string[];inputSchema:unknown}>}};
    expect(listing.data.operations).toHaveLength(1);
    const op=listing.data.operations[0]!;
    expect(op).toMatchObject({operation:"file_read",requiredScopes:["resources:read"],inputSchema:{properties:{data:{properties:{fieldKey:{enum:["attachment","otherAttachment"]}}}}}});
    const downloaded=await f.request("POST",base+"/_operations/"+op.operationRef+"/invoke",{},{
      arguments:{spaceId:f.space,recordId:record.id,data:payload},
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    const descriptor=await downloaded.json() as {data:{id:string;name:string;contentType:string;size:number;url:string;expiresAt:string}};
    expect(descriptor.data).toMatchObject({id:fileId,name:"synthetic.pdf",contentType:"application/pdf",size:12});
    expect(new URL(descriptor.data.url).searchParams.get("X-Amz-Signature")).toBeTruthy();
    await configure(["get"]);
    expect((await f.request("POST",base+"/_operations/"+op.operationRef+"/invoke",{},{
      arguments:{spaceId:f.space,recordId:record.id,data:payload},
    })).status).toBe(404);
    await configure(["get","file_read"]);
    f.setDelegationEnabled(true);
    const patch={oauth_allow_user_authorization:true};
    const requested=await f.request("POST",base+"/oauth-delegation-requests",patch,{modelKey,operation:"file_read",reason:"Read one approved synthetic file"});
    expect(requested.status).toBe(201);
    const requestId=(await requested.json() as {data:{id:string}}).data.id;
    const approved=await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+requestId+"/approve",{});
    expect(approved.status).toBe(200);
    const dlg=(await approved.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const represented={...patch,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg};
    const headers={"x-lifespace-delegation-id":dlg};
    expect((await f.request("POST",route,represented,payload)).status).toBe(403);
    expect((await f.request("GET",route.replace("/file-downloads",""),represented,undefined,headers)).status).toBe(404);
    expect((await f.request("POST",route,represented,payload,headers)).status).toBe(200);
    expect((await f.request("POST",route,represented,payload,headers)).status).toBe(403);
    // One Account decision grants three independent, exact-operation Delegations.
    await configure(["query","get","file_read"]);
    const composite=await f.request("POST",base+"/oauth-delegation-requests",patch,{
      operations:[{modelKey,operation:"query"},{modelKey,operation:"get"},
        {modelKey,operation:"file_read"}],
      reason:"List documents and read one linked PDF in one approval",
    });
    expect(composite.status).toBe(201);
    const compositeId=(await composite.json() as {data:{id:string;operations:Array<{operation:string}>}}).data;
    expect(compositeId.operations.map(x=>x.operation)).toEqual(["query","get","file_read"]);
    const preview=await f.accountRequest("GET","/api/v1/me/oauth/delegation-requests/"+compositeId.id);
    expect(preview.status).toBe(200);
    expect((await preview.json() as {data:{operations:Array<{operation:string}>}}).data.operations.map(x=>x.operation))
      .toEqual(["query","get","file_read"]);
    const compositionApproval=await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+compositeId.id+"/approve",{});
    expect(compositionApproval.status).toBe(200);
    const issued=(await compositionApproval.json() as {data:{delegations:Array<{id:string}>}}).data.delegations;
    expect(issued).toHaveLength(3);
    expect(new Set(issued.map(x=>x.id)).size).toBe(3);
    const status=await f.request("GET",base+"/oauth-delegation-requests/"+compositeId.id,patch);
    expect(status.status).toBe(200);
    expect((await status.json() as {data:{operations:Array<{delegationId:string}>}}).data.operations
      .map(x=>x.delegationId)).toEqual(issued.map(x=>x.id));
    const withGrant=(id:string)=>({...patch,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:id});
    const selector=(id:string)=>({"x-lifespace-delegation-id":id});
    const queryRoute=base+"/models/"+modelKey+"/records/query";
    const getRoute=base+"/models/"+modelKey+"/records/"+record.id;
    expect((await f.request("POST",queryRoute,withGrant(issued[2]!.id),{page:{limit:1}},selector(issued[2]!.id))).status).toBe(404);
    expect((await f.request("POST",queryRoute,withGrant(issued[0]!.id),{page:{limit:1}},selector(issued[0]!.id))).status).toBe(200);
    expect((await f.request("GET",getRoute,withGrant(issued[1]!.id),undefined,selector(issued[1]!.id))).status).toBe(200);
    expect((await f.request("POST",route,withGrant(issued[2]!.id),payload,selector(issued[2]!.id))).status).toBe(200);
    expect((await f.request("POST",route,withGrant(issued[2]!.id),payload,selector(issued[2]!.id))).status).toBe(403);
    const approvedList=await f.accountRequest("GET","/api/v1/me/oauth/delegations");
    expect((await approvedList.json() as {data:{items:Array<{id:string;operation:string}>}}).data.items
      .filter(x=>issued.some(y=>y.id===x.id)).every(x=>["query","get","file_read"].includes(x.operation))).toBe(true);
    const invalid=await f.request("POST",base+"/oauth-delegation-requests",patch,{
      operations:[{modelKey,operation:"query"},{modelKey,operation:"query"}],
      reason:"Never duplicate a composite operation",
    });
    expect(invalid.status).toBe(400);
    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE grantee_id=? AND source_space_id=?").bind(now,f.agent,f.space).run();
    expect((await f.request("POST",route,patch,payload)).status).toBe(403);
  });

  it("authorizes a relation only with exact approved source operation and target get from the same OAuth context", async()=>{
    const f=await fixture(), suffix=crypto.randomUUID().replaceAll("-","").slice(0,12), now=new Date().toISOString();
    const sourceKey="rel_source_"+suffix,targetKey="rel_target_"+suffix;
    const publisher:Principal={type:"service",id:"svc_"+suffix,clientId:"lifespace-platform-admin",scopes:["models:manage"],tokenId:"tok_"+suffix};
    for(const key of [sourceKey,targetKey]){
      await publishModelDefinition({DB:f.db} as Bindings,publisher,{
        definitionVersion:1,key,display:{singular:"Synthetic",plural:"Synthetic records"},
        fields:{name:{type:"string",required:true}},access:["read","write"],
        ...(key===sourceKey?{semanticRelations:{outgoing:["relates_to"]}}:{}),
      },"initial");
    }
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+suffix,f.space,f.oauthUser,now,now),
      f.db.prepare("DELETE FROM data_grants WHERE grantee_type='agent' AND grantee_id=?").bind(f.agent),
      ...[sourceKey,targetKey].map(key=>f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)")
        .bind(f.application,key,"write","service",publisher.id)),
      f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?").bind(JSON.stringify({models:[
        {modelKey:sourceKey,operations:["create","update","relation_create","relation_get","relation_query","relation_delete"]},
        {modelKey:targetKey,operations:["create","get","query"]},
      ]}),f.serverId),
    ]);
    f.setDelegationEnabled(true);f.setConsentScopes(["resources:read","resources:write"]);
    const actor={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    const base="/api/v1/spaces/"+f.space;
    const operations=[...["create","update","relation_create","relation_get","relation_query","relation_delete"].map(operation=>({modelKey:sourceKey,operation})),
      ...["create","get","query"].map(operation=>({modelKey:targetKey,operation}))];
    const eligible=await f.request("GET",base+"/_authority/delegation-eligibility",actor);
    expect(eligible.status).toBe(200);
    expect((await eligible.json() as {data:{eligibleOperations:Array<{operation:string}>}}).data.eligibleOperations.map(x=>x.operation)).toContain("relation_create");
    const pending=await f.request("POST",base+"/oauth-delegation-requests",actor,{operations,reason:"Synthetic governed relation"});
    expect(pending.status).toBe(201);
    const id=(await pending.json() as {data:{id:string}}).data.id;
    const approval=await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+id+"/approve",{mode:"until_revoked"});
    expect(approval.status).toBe(200);
    const granted=(await approval.json() as {data:{delegations:Array<{id:string}>}}).data.delegations;
    const get=(model:string,operation:string)=>granted[operations.findIndex(op=>op.modelKey===model&&op.operation===operation)]!.id;
    const call=(method:string,path:string,dlg:string,body?:unknown,target?:string)=>f.request(method,path,
      {...actor,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg},body,
      {"x-lifespace-delegation-id":dlg,...(target?{"x-lifespace-target-delegation-id":target}:{})});
    const record=async(key:string)=>{const r=await call("POST",base+"/models/"+key+"/records",get(key,"create"),{name:"Synthetic"});expect(r.status).toBe(201);return (await r.json() as {data:{id:string}}).data.id};
    const source={kind:"record",modelKey:sourceKey,recordId:await record(sourceKey)};
    const target={kind:"record",modelKey:targetKey,recordId:await record(targetKey)};
    const edge={source,target,predicate:"relates_to"};
    const path=base+"/semantic-relations", create=get(sourceKey,"relation_create"), targetGet=get(targetKey,"get");
    expect((await call("POST",path,get(sourceKey,"update"),edge,targetGet)).status).toBe(404);
    expect((await call("POST",path,create,edge)).status).toBe(404);
    expect((await call("POST",path,create,edge,get(targetKey,"query"))).status).toBe(404);
    expect((await f.request("POST",path,actor,edge)).status).toBe(403);
    expect((await call("POST",path,create,{...edge,target:{...target,modelKey:sourceKey}},targetGet)).status).toBe(404);
    const describe=await call("GET",base+"/_discovery/operations?modelKey="+sourceKey+"&operation=relation_create",create);
    expect(describe.status).toBe(200);
    const descriptor=(await describe.json() as {data:{operations:Array<{inputSchema:Record<string,unknown>}>}}).data.operations;
    expect(descriptor).toHaveLength(1);
    expect(descriptor[0]!.inputSchema).toMatchObject({required:["spaceId","targetDelegationId","data"],
      properties:{data:{properties:{predicate:{enum:["relates_to"]}}}}});
    expect((await call("GET",base+"/_discovery/operations?modelKey="+sourceKey+"&operation=relation_create",get(sourceKey,"update"))).status).toBe(404);
    // Joint regression: the same nine-operation approval permits exact CRUD
    // preview/PATCH and standalone edge execution, without cross-operation use.
    const update=get(sourceKey,"update");
    const updatePreview=base+"/_discovery/operations?modelKey="+sourceKey+"&operation=update";
    const ordinary=await call("GET",updatePreview,update);
    expect(ordinary.status).toBe(200);
    const ordinarySchema=(await ordinary.json() as {data:{operations:Array<{operation:string;inputSchema:{properties:{data:{$ref:string}};$defs:Record<string,{required:string[]}>}}>}}).data.operations;
    expect(ordinarySchema).toHaveLength(1);
    expect(ordinarySchema[0]!.operation).toBe("update");
    const input=ordinarySchema[0]!.inputSchema;
    expect(input.$defs[input.properties.data.$ref.slice(8)]!.required).toContain("version");
    expect((await call("GET",updatePreview,create)).status).toBe(404);
    expect((await call("GET",updatePreview,update,undefined,targetGet)).status).toBe(404);
    const recordPath=base+"/models/"+sourceKey+"/records/"+source.recordId;
    const corrected=await call("PATCH",recordPath,update,{version:1,name:"Synthetic corrected"});
    expect(corrected.status).toBe(200);
    expect((await corrected.json() as {data:{version:number}}).data.version).toBe(2);
    expect((await call("PATCH",recordPath,create,{version:2,name:"Forbidden"})).status).toBe(404);
    const added=await call("POST",path,create,edge,targetGet);
    expect(added.status).toBe(200);
    const relationId=(await added.json() as {data:{id:string}}).data.id;
    const read=await call("GET",path+"/"+relationId,get(sourceKey,"relation_get"),undefined,targetGet);
    expect(read.status).toBe(200);
    const query=path+"?"+new URLSearchParams({sourceModelKey:sourceKey,sourceRecordId:source.recordId,targetModelKey:targetKey,targetRecordId:target.recordId}).toString();
    expect((await call("GET",query,get(sourceKey,"relation_query"),undefined,targetGet)).status).toBe(200);
    expect((await call("GET",path+"/"+relationId,create,undefined,targetGet)).status).toBe(404);
    expect((await call("DELETE",path+"/"+relationId,get(sourceKey,"relation_delete"),undefined,targetGet)).status).toBe(204);
    expect((await call("POST",path,create,edge,targetGet)).status).toBe(200);
    await f.accountRequest("POST","/api/v1/me/oauth/delegations/"+targetGet+"/revoke",{});
    const denied=await call("POST",path,create,edge,targetGet);
    expect([403,404]).toContain(denied.status);
  });

  it("approves 32 exact operations across 8 models in one atomic Account decision", async () => {
    const f=await fixture();
    const suffix=crypto.randomUUID().replaceAll("-","");
    const timestamp=new Date().toISOString();
    const publisher:Principal={type:"service",id:"svc_"+suffix,clientId:"lifespace-platform-admin",scopes:["models:manage"],tokenId:"tok_publish_"+suffix};
    const modelKeys=Array.from({length:8},(_,i)=>"oauth_batch_"+suffix.slice(0,10)+"_"+i);
    const ops=["get","query","create","update"];
    for(const key of modelKeys) {
      await publishModelDefinition({DB:f.db} as Bindings,publisher,{
        definitionVersion:1,key,display:{singular:"Synthetic",plural:"Synthetic records"},
        fields:{label:{type:"string",nullable:true}},access:["read","write"],
      },"initial");
    }
    await f.db.batch([
      ...modelKeys.map(key=>f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)").bind(f.application,key,"write","service",publisher.id)),
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)").bind("mem_"+suffix,f.space,f.oauthUser,timestamp,timestamp),
      f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?").bind(JSON.stringify({models:modelKeys.map(modelKey=>({modelKey,operations:ops}))}),f.serverId),
    ]);
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    const patch={oauth_allow_user_authorization:true,scope:"resources:read resources:write"};
    const operations=modelKeys.flatMap(modelKey=>ops.map(operation=>({modelKey,operation})));
    const base="/api/v1/spaces/"+f.space+"/oauth-delegation-requests";
    const pending=await f.request("POST",base,patch,{operations,reason:"Approve a bounded synthetic workflow"});
    expect(pending.status).toBe(201);
    const requestId=(await pending.json() as {data:{id:string}}).data.id;
    const preview=await f.accountRequest("GET","/api/v1/me/oauth/delegation-requests/"+requestId);
    expect(preview.status).toBe(200);
    expect((await preview.json() as {data:{operations:unknown[]}}).data.operations).toEqual(operations);
    const result=await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+requestId+"/approve",{mode:"until_revoked"});
    expect(result.status).toBe(200);
    const issued=(await result.json() as {data:{delegations:Array<{id:string}>}}).data.delegations;
    expect(issued).toHaveLength(32);
    expect(new Set(issued.map(x=>x.id)).size).toBe(32);
    const status=await f.request("GET",base+"/"+requestId,patch);
    expect((await status.json() as {data:{operations:Array<{delegationId:string}>}}).data.operations.map(x=>x.delegationId)).toEqual(issued.map(x=>x.id));
    expect((await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+requestId+"/approve",{mode:"until_revoked"})).status).toBe(409);
  });

  it("projects native file_upload, verifies both phases and preserves write and exact delegated authority", async () => {
    const f=await fixture();
    const suffix=crypto.randomUUID().replaceAll("-","");
    const modelKey="oauth_upload_"+suffix.slice(0,12);
    const now=new Date().toISOString();
    const bindings={DB:f.db} as Bindings;
    await publishModelDefinition(bindings,{
      type:"service",id:"svc_"+suffix,clientId:"lifespace-platform-admin",scopes:["models:manage"],tokenId:"tok_publish_"+suffix,
    },{
      definitionVersion:1,key:modelKey,display:{singular:"Synthetic upload",plural:"Synthetic uploads"},
      fields:{attachment:{type:"file",nullable:true},label:{type:"string",nullable:true}},access:["read","write"],
    },"initial");
    await f.db.batch([
      f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)").bind(f.application,modelKey,"write","service","svc_"+suffix),
      f.db.prepare("UPDATE data_grants SET permission='write' WHERE grantee_id=? AND source_space_id=?").bind(f.agent,f.space),
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)").bind("mem_"+suffix,f.space,f.oauthUser,now,now),
    ]);
    const configure=async(operations:string[])=>f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?").bind(JSON.stringify({models:[{modelKey,operations}]}),f.serverId).run();
    const base="/api/v1/spaces/"+f.space;
    const route=base+"/models/"+modelKey+"/file-uploads";
    const bytes=new TextEncoder().encode("synthetic upload");
    const payload={fieldKey:"attachment",name:"synthetic.txt",contentType:"text/plain",size:bytes.length};
    const write={scope:"resources:read resources:write"};
    f.setConsentScopes(["resources:read","resources:write"]);
    await configure(["get"]);
    expect((await f.request("POST",route,write,payload)).status).toBe(403);
    await configure(["file_upload"]);
    expect((await f.request("POST",route,{},payload)).status).toBe(403);
    expect((await f.request("POST",base+"/file-uploads",write,{modelKey,...payload})).status).toBe(403);
    expect((await f.request("POST",route.replace(f.space,f.other),write,payload)).status).toBe(403);
    expect((await f.request("POST",route,write,{...payload,fieldKey:"label"})).status).toBe(405);
    const catalog=await f.request("GET",base+"/_discovery/operations?modelKey="+modelKey+"&operation=file_upload");
    expect(catalog.status).toBe(200);
    const op=(await catalog.json() as {data:{operations:Array<{operationRef:string;requiredScopes:string[];operation:string}>}}).data.operations[0]!;
    expect(op).toMatchObject({operation:"file_upload",requiredScopes:["resources:read","resources:write"]});
    const invoke=(patch:Record<string,unknown>,data:unknown)=>f.request("POST",base+"/_operations/"+op.operationRef+"/invoke",patch,{arguments:{spaceId:f.space,data}});
    expect((await invoke({},{phase:"begin",...payload})).status).toBe(403);
    const start=await invoke(write,{phase:"begin",...payload});
    expect(start.status).toBe(201);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const descriptor=(await start.json() as {data:{id:string;destination:string;upload:{url:string;method:string;headers:Record<string,string>}}}).data;
    expect(descriptor).toMatchObject({destination:"native",upload:{method:"PUT",headers:{"content-type":"text/plain"}}});
    expect(new URL(descriptor.upload.url).searchParams.get("X-Amz-Signature")).toBeTruthy();
    const row=await f.db.prepare("SELECT object_key,file_id FROM file_upload_sessions WHERE id=?").bind(descriptor.id).first<{object_key:string;file_id:string}>();
    expect(row).toBeTruthy();
    const complete=route+"/"+descriptor.id+"/complete";
    expect((await invoke(write,{phase:"complete",uploadId:descriptor.id})).status).toBe(409);
    const bucket=(env as unknown as TestEnv).ASSETS;
    await bucket.put(row!.object_key,bytes,{httpMetadata:{contentType:"text/plain"}});
    await configure(["get"]);
    expect((await f.request("POST",complete,write)).status).toBe(403);
    await configure(["file_upload"]);
    const result=await invoke(write,{phase:"complete",uploadId:descriptor.id});
    expect(result.status).toBe(200);
    const file=(await result.json() as {data:{id:string}}).data;
    expect(file.id).toBe(row!.file_id);
    expect(await (await bucket.get("files/"+f.space+"/"+file.id))?.text()).toBe("synthetic upload");
    expect((await invoke(write,{phase:"complete",uploadId:descriptor.id})).status).toBe(409);
    // Upload permission does not imply record creation or update.
    expect((await f.request("POST",base+"/models/"+modelKey+"/records",write,{attachment:file.id})).status).toBe(403);
    f.setDelegationEnabled(true);
    const delegatedWrite={...write,oauth_allow_user_authorization:true};
    const requested=await f.request("POST",base+"/oauth-delegation-requests",delegatedWrite,{modelKey,operation:"file_upload",reason:"Upload synthetic attachment"});
    expect(requested.status).toBe(201);
    const requestId=(await requested.json() as {data:{id:string}}).data.id;
    const approve="/api/v1/me/oauth/delegation-requests/"+requestId+"/approve";
    expect((await f.accountRequest("POST",approve,{})).status).toBe(422);
    const approved=await f.accountRequest("POST",approve,{mode:"timed",durationMinutes:60});
    expect(approved.status).toBe(200);
    const dlg=(await approved.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const represented={...delegatedWrite,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg};
    const headers={"x-lifespace-delegation-id":dlg};
    const begin=await f.request("POST",route,represented,payload,headers);
    expect(begin.status).toBe(201);
    const second=(await begin.json() as {data:{id:string}}).data.id;
    // An independently authorized direct Agent cannot finalize the user's upload.
    const completeSecond=route+"/"+second+"/complete";
    expect((await f.request("POST",completeSecond,delegatedWrite)).status).toBe(403);
    const secondRow=await f.db.prepare("SELECT object_key FROM file_upload_sessions WHERE id=?").bind(second).first<{object_key:string}>();
    await bucket.put(secondRow!.object_key,bytes,{httpMetadata:{contentType:"text/plain"}});
    expect((await f.request("POST",completeSecond,represented,undefined,headers)).status).toBe(200);
    await f.db.prepare("UPDATE delegations SET revoked_at=? WHERE id=?").bind(now,dlg).run();
    expect((await f.request("POST",route,represented,payload,headers)).status).toBe(403);
  }, 20000);

  it("valid signed Agent JWT is current-state rechecked and inventory cannot disclose second granted Space", async () => {
    const f = await fixture();
    const signed = await f.jwt();
    await expect(verifyAccessToken(signed, f.publicKey)).resolves.toMatchObject({
      type: "agent", id: f.agent, clientId: f.application,
      purpose: "oauth_agent_execution", scopes: ["resources:read"],
      oauthExecution: { spaceId: f.space, agentId: f.agent },
    });
    const inventory = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(inventory.status).toBe(200);
    const payload = await inventory.json() as { data: { spaces: Array<{ spaceId: string }> } };
    expect(payload.data.spaces.some(s => s.spaceId === f.other)).toBe(false);
    expect(payload.data.spaces.every(s => s.spaceId === f.space)).toBe(true);
    expect(f.lastBody()).toMatchObject({
      authorizationId: f.claims.oauth_authorization_id, tokenHash: f.claims.oauth_access_hash,
      applicationId: f.application, agentId: f.agent, spaceId: f.space,
    });
    f.setActive(false);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory")).status).toBe(401);
    expect(f.checks()).toBe(2);
  });

  it("rejects mutation and other Space *before* Identity introspection, never falls back to User authority", async () => {
    const f = await fixture();
    expect((await f.request("GET", "/api/v1/spaces/" + f.other + "/_discovery/models/task")).status).toBe(403);
    expect((await f.request("POST", "/api/v1/spaces/" + f.space + "/models/task/records", {}, {})).status).toBe(403);
    expect((await f.request("GET", "/api/v1/me/spaces")).status).toBe(403);
    expect(f.checks()).toBe(0);
    const detail = await f.request("GET", "/api/v1/spaces/" + f.space + "/_discovery/models/task");
    expect(detail.status).toBe(200);
    expect(f.checks()).toBe(1);
  });

  it("rejects forged scope, User representation, long-lived JWT and unsanctioned OAuth context", async () => {
    const f = await fixture();
    for (const patch of [
      { scope: "resources:write" },
      { scope: "resources:manage" },
      { scope: ["resources:read"] },
      { principal_type: "user", principal_id: "usr_forged" },
      { purpose: "agent_execution" },
      { oauth_space_id: null },
      { oauth_access_hash: "not-a-token-hash" },
      { exp: f.claims.exp + 240 },
      { oauth_resource: "https://evil.example.test/mcp" , oauth_authorization_id: null },
    ]) {
      expect((await f.request("GET", "/api/v1/me/_discovery/inventory", patch)).status).toBe(401);
    }
    expect(f.checks()).toBe(0);
  });
  it("validates HTTPS URL-form OAuth client ID in Identity-signed Agent JWT", async () => {
    const f = await fixture();
    const clientId = "https://client.example.com/oauth/client.json";
    const signed = await f.jwt({ oauth_client_id: clientId });
    await expect(verifyAccessToken(signed, f.publicKey)).resolves.toMatchObject({
      oauthExecution: { clientId },
      purpose: "oauth_agent_execution",
    });
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory",
      { oauth_client_id: clientId })).status).toBe(200);
    expect(f.lastBody()).toMatchObject({ clientId });
    for (const badId of [
      "http://client.example.com/oauth/client.json",
      "https://client.example.com/oauth/client.json?scope=all",
      "https://client.example.com/",
      "https://bad:pass@client.example.com/oauth/client.json",
    ]) {
      expect((await f.request("GET", "/api/v1/me/_discovery/inventory",
        { oauth_client_id: badId })).status).toBe(401);
    }
  });

  it("denies a disabled Core MCP Server even while OAuth is still active", async () => {
    const f = await fixture();
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory")).status).toBe(200);
    await f.setServerEnabled(false);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory")).status).toBe(403);
    expect((await f.request("GET", "/api/v1/spaces/" + f.space + "/_discovery/models/task")).status).toBe(403);
  });

  it("keeps Get-only Model discovery but revokes Query after live MCP Server operation changes", async () => {
    const f = await fixture();
    const first = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(first.status).toBe(200);
    const models = (await first.json() as { data: { models: Array<{ key: string }> } }).data.models;
    expect(models.some(model => model.key === "task")).toBe(true);
    await f.setServerOperations(["get"]);
    const second = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(second.status).toBe(200);
    const body = await second.json() as { data: { models: unknown[]; spaces: unknown[] } };
    // Get is still enabled, so the model remains discoverable; Query is not.
    expect(body.data.models).toHaveLength(1);
    expect(body.data.spaces).toHaveLength(1);
    expect((await f.request("GET", "/api/v1/spaces/" + f.space + "/_discovery/models/task")).status).toBe(200);
    expect((await f.request("POST", "/api/v1/spaces/" + f.space + "/models/task/records/query", {}, {})).status).toBe(403);
  });

  it("batch semantic discovery rechecks every requested Model and live policy without extra Worker calls", async () => {
    const f = await fixture();
    const path = "/api/v1/spaces/" + f.space + "/_discovery/models/batch";
    const allowed = await f.request("POST", path, {}, { modelKeys: ["task"] });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { data: { models: Array<{modelKey: string; detail: {key: string}}> } };
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0]).toMatchObject({ modelKey: "task", detail: { key: "task" } });
    expect(f.checks()).toBe(1);
    // Reject requests for unselected Models, duplicates, cross-Space and
    // extra fields; returning a partial batch would leak semantic metadata.
    expect((await f.request("POST", path, {}, { modelKeys: ["task", "activity"] })).status).toBe(404);
    expect((await f.request("POST", path, {}, { modelKeys: ["task", "task"] })).status).toBe(400);
    expect((await f.request("POST", path, {}, { modelKeys: ["task"], includeAll: true })).status).toBe(400);
    expect((await f.request("POST",
      "/api/v1/spaces/" + f.other + "/_discovery/models/batch", {}, { modelKeys: ["task"] })).status).toBe(403);
    await f.setServerOperations(["get"]);
    const getOnly = await f.request("POST", path, {}, { modelKeys: ["task"] });
    expect(getOnly.status).toBe(200);
    expect((await getOnly.json() as { data: {models: Array<{detail:{mcpOperations:string[]}}> }}).data.models[0].detail.mcpOperations).toEqual(["get"]);
    await f.setServerEnabled(false);
    expect((await f.request("POST", path, {}, { modelKeys: ["task"] })).status).toBe(403);
  });

  it("allows consented CRUD regardless of environment, bounded by current Server/Grant/Application", async () => {
    const f = await fixture();
    const patch = { scope: "resources:read resources:write" };
    f.setConsentScopes(["resources:read", "resources:write"]);
    await f.setServerOperations(["query", "create", "update", "delete"]);
    const base = "/api/v1/spaces/" + f.space + "/models/task/records";
    // A signed write claim does not fill a missing Agent Data Grant.
    expect((await f.request("POST", base, patch, { name: "Synthetic OAuth task" })).status).toBe(403);
    await f.db.prepare("UPDATE data_grants SET permission='write' WHERE source_space_id=? AND grantee_id=?")
      .bind(f.space, f.agent).run();
    expect((await f.request("POST", base, patch, { name: "Synthetic OAuth task" })).status).toBe(403);
    await f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'")
      .bind(f.application).run();
    const batch = await f.request("POST", "/api/v1/spaces/" + f.space + "/_discovery/models/batch", patch, { modelKeys: ["task"] });
    expect(batch.status).toBe(200);
    const preview = await batch.json() as { data: { models: Array<{ detail: { mutations: { contractId: string; operations: Record<string, unknown> } } }> } };
    expect(preview.data.models[0].detail.mutations.contractId).toMatch(/^mct_/u);
    expect(Object.keys(preview.data.models[0].detail.mutations.operations)).toEqual(["create", "update", "delete"]);
    const created = await f.request("POST", base, patch, { name: "Synthetic OAuth task" });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; version: number; createdBy: { type: string; id: string } } };
    expect(createdBody.data.createdBy).toMatchObject({ type: "agent", id: f.agent });
    const record = createdBody.data;
    // Native Get is visible only if the current Server explicitly enables get.
    expect((await f.request("GET", base + "/" + record.id)).status).toBe(403);
    await f.setServerOperations(["get", "query", "create", "update", "delete"]);
    const got = await f.request("GET", base + "/" + record.id);
    expect(got.status).toBe(200);
    expect((await got.json() as { data: { id: string } }).data.id).toBe(record.id);
    expect((await f.request("PATCH", base + "/" + record.id, patch, { version: record.version, name: "Updated synthetic OAuth task" })).status).toBe(200);
    expect((await f.request("PATCH", base + "/" + record.id, patch, { version: record.version, name: "Stale update" })).status).toBe(409);
    // Narrowing Server exposure immediately denies the old mutation.
    await f.setServerOperations(["query"]);
    expect((await f.request("DELETE", base + "/" + record.id, patch, { version: record.version + 1 })).status).toBe(403);
    await f.setServerOperations(["query", "delete"]);
    // Removing write from live OAuth consent invalidates a still-valid JWT.
    f.setConsentScopes(["resources:read"]);
    expect((await f.request("DELETE", base + "/" + record.id, patch, { version: record.version + 1 })).status).toBe(401);
    f.setConsentScopes(["resources:read", "resources:write"]);
    // Production semantics are not artificially narrowed: current consent,
    // configured Server operation and Core authority decide the outcome.
    f.setEnvironment("production");
    expect((await f.request("DELETE", base + "/" + record.id, patch, { version: record.version + 1 })).status).toBe(204);
    expect((await f.request("POST", base, {}, { name: "No write scope" })).status).toBe(403);
    expect((await f.request("POST", base.replace(f.space, f.other), patch, { name: "Cross-Space" })).status).toBe(403);
  });

  it("get-only MCP Server discovers the model, but cannot invoke Query or mutation", async () => {
    const f = await fixture();
    await f.setServerOperations(["get"]);
    const inventory = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(inventory.status).toBe(200);
    const state = await inventory.json() as { data: { spaces: Array<{ models: Array<{ modelKey: string }> }> } };
    expect(state.data.spaces.flatMap(s => s.models).some(m => m.modelKey === "task")).toBe(true);
    expect((await f.request("POST",
      "/api/v1/spaces/" + f.space + "/models/task/records/query", {}, {})).status).toBe(403);
    const batch = await f.request("POST", "/api/v1/spaces/" + f.space + "/_discovery/models/batch",
      {}, { modelKeys: ["task"] });
    expect(batch.status).toBe(200);
    const projected = await batch.json() as { data: { models: Array<{ detail: { mcpOperations: string[] } }> } };
    expect(projected.data.models[0].detail.mcpOperations).toEqual(["get"]);
    // The canonical Get is allowed through routing and current Server policy,
    // then ordinary record-level access determines whether the record exists.
    expect((await f.request("GET",
      "/api/v1/spaces/" + f.space + "/models/task/records/rec_missing")).status).toBe(404);
  });

  it("third-party OAuth Account confirms only intended User, trusted Agent API remains isolated, Delegation consumes once", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space+"/models/task/records";
    const transport="/api/v1/spaces/"+f.space+"/oauth-delegation-requests";
    await f.setServerOperations(["query","create","get"]);
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    const timestamp=new Date().toISOString();
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+crypto.randomUUID().replaceAll("-",""),f.space,f.oauthUser,timestamp,timestamp),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'")
        .bind(f.application),
    ]);
    const jwtPatch={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    expect((await f.request("POST",base,jwtPatch,{name:"Direct create denied"})).status).toBe(403);
    const applied=await f.request("POST",transport,jwtPatch,{
      modelKey:"task",operation:"create",reason:"Create one approved task",
    });
    expect(applied.status).toBe(201);
    const requested=await applied.json() as {data:{id:string;approvalUrl:string;status:string}};
    expect(requested.data.status).toBe("pending");
    expect(requested.data.approvalUrl).toContain("account-staging.aisr.online/delegation?request_id="+requested.data.id);
    expect((await f.request("POST",
      "/api/v1/spaces/"+f.space+"/authorization-requests/"+requested.data.id+"/confirm",
      jwtPatch,{principalUserId:f.oauthUser})).status).toBe(403);
    // Even a genuinely trusted Agent's original approval transport cannot
    // approve a request created under the third-party OAuth Account channel.
    expect((await f.trustedRequest("POST",
      "/api/v1/spaces/"+f.space+"/authorization-requests/"+requested.data.id+"/confirm",
      {principalUserId:f.oauthUser})).status).toBe(404);
    // A future externally confirmed channel must not accidentally become
    // a trusted Agent approval path just because its tag is not "oauth_mcp".
    const original=await f.db.prepare(
      "SELECT correlation_json FROM authorization_requests WHERE id=?")
      .bind(requested.data.id).first<{correlation_json:string}>();
    const future={...JSON.parse(original!.correlation_json),channel:"future_web_approval"};
    await f.db.prepare("UPDATE authorization_requests SET correlation_json=? WHERE id=?")
      .bind(JSON.stringify(future),requested.data.id).run();
    expect((await f.trustedRequest("POST",
      "/api/v1/spaces/"+f.space+"/authorization-requests/"+requested.data.id+"/confirm",
      {principalUserId:f.oauthUser})).status).toBe(404);
    await f.db.prepare("UPDATE authorization_requests SET correlation_json=? WHERE id=?")
      .bind(original!.correlation_json,requested.data.id).run();
    const before=await f.accountRequest("GET","/api/v1/me/oauth/delegation-requests/"+requested.data.id);
    expect(before.status).toBe(200);
    expect((await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+requested.data.id+"/approve",
      {}, "usr_other")).status).toBe(404);
    const confirmed=await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+requested.data.id+"/approve",{});
    expect(confirmed.status).toBe(200);
    const approved=await confirmed.json() as {data:{delegations:Array<{id:string}>}};
    const delegationId=approved.data.delegations[0]!.id;
    expect(delegationId).toMatch(/^dlg_/u);
    expect((await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+requested.data.id+"/approve",{})).status).toBe(409);
    const represented={...jwtPatch,principal_type:"user",principal_id:f.oauthUser,
      oauth_delegation_id:delegationId};
    expect((await f.request("POST",base,represented,{name:"No selector"})).status).toBe(403);
    const headers={"x-lifespace-delegation-id":delegationId};
    const created=await f.request("POST",base,represented,{name:"Approved once"},headers);
    expect(created.status).toBe(201);
    const data=await created.json() as {data:{id:string;createdBy:{id:string;type:string}}};
    // Record ownership/audit displays the User Principal. The authoritative
    // Change explicitly attributes the actual Agent Actor and Delegation.
    expect(data.data.createdBy).toMatchObject({type:"user",id:f.oauthUser});
    const change=await f.db.prepare(
      "SELECT principal_type,principal_id,actor_type,actor_id,application_id,delegation_id " +
      "FROM resource_changes WHERE record_id=? ORDER BY occurred_at DESC LIMIT 1"
    ).bind(data.data.id).first<Record<string,string>>();
    expect(change).toMatchObject({
      principal_type:"user",principal_id:f.oauthUser,
      actor_type:"agent",actor_id:f.agent,
      application_id:f.application,delegation_id:delegationId,
    });
    expect((await f.request("POST",base,represented,{name:"Again"},headers)).status).toBe(403);
    const scoped=await f.request("POST",base+"/query",represented,{limit:1},headers);
    // Exact approved operation mismatch is deliberately indistinguishable
    // from another User/Client/Server's delegation (404, not scope disclosure).
    expect(scoped.status).toBe(404);

    // The same Account-link channel also handles a published *semantic Action*
    // without giving any trusted Agent or OAuth client permission to self-approve.
    await f.setServerOperations(["query","get","create","action:complete"]);
    const actionRequested=await f.request("POST",transport,jwtPatch,{
      modelKey:"task",operation:"action:complete",reason:"Complete exactly this authorized task",
    });
    expect(actionRequested.status).toBe(201);
    const actionArq=await actionRequested.json() as {data:{id:string;approvalUrl:string}};
    expect((await f.trustedRequest("POST",
      "/api/v1/spaces/"+f.space+"/authorization-requests/"+actionArq.data.id+"/confirm",
      {principalUserId:f.oauthUser})).status).toBe(404);
    const actionApproved=await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+actionArq.data.id+"/approve",{});
    expect(actionApproved.status).toBe(200);
    const actionBody=await actionApproved.json() as {data:{delegations:Array<{id:string}>}};
    const actionDlg=actionBody.data.delegations[0]!.id;
    const actionRepresented={...jwtPatch,principal_type:"user",principal_id:f.oauthUser,
      oauth_delegation_id:actionDlg};
    const actionPath=base+"/"+data.data.id+"/actions/complete";
    const actionOnce=await f.request("POST",actionPath,actionRepresented,
      {version:1},{"x-lifespace-delegation-id":actionDlg});
    expect(actionOnce.status).toBe(200);
    expect((await f.request("POST",actionPath,actionRepresented,
      {version:1},{"x-lifespace-delegation-id":actionDlg})).status).toBe(403);
    f.setActive(false);
    expect((await f.request("POST",base,represented,{name:"Revoked"},headers)).status).toBe(401);
  });

  it("rechecks the represented User ceiling for OAuth approval and already-issued delegation, without changing independent Agent grants",async()=>{
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    const records=base+"/models/task/records";
    const manager="usr_owner_"+crypto.randomUUID().replaceAll("-","");
    const now=new Date().toISOString();
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    await f.setServerOperations(["query","get","create"]);
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind("mem_owner_"+manager,f.space,manager,"owner",now,now),
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind("mem_editor_"+f.oauthUser,f.space,f.oauthUser,"editor",now,now),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'").bind(f.application),
    ]);
    const patch={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    const issue=async(reason:string)=>{
      const response=await f.request("POST",base+"/oauth-delegation-requests",patch,{modelKey:"task",operation:"create",reason});
      expect(response.status).toBe(201);
      return (await response.json() as {data:{id:string}}).data.id;
    };
    const approve=(id:string)=>f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+id+"/approve",{mode:"until_revoked"});
    const approved=await approve(await issue("First approved write"));
    expect(approved.status).toBe(200);
    const dlg=(await approved.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const represented={...patch,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg};
    const headers={"x-lifespace-delegation-id":dlg};
    const pending=await issue("Second pending write");
    const managePath=base+"/members/"+f.oauthUser+"/model-access/task";
    const count=async()=>Number(await f.db.prepare("SELECT COUNT(*) n FROM resource_records WHERE space_id=? AND model_key='task'").bind(f.space).first("n"));
    expect((await f.request("POST",records,represented,{name:"Before limit"},headers)).status).toBe(201);
    const beforeCount=await count();
    const directManifest=async()=>{
      const response=await f.request("GET",base+"/_discovery/operations",patch);
      expect(response.status).toBe(200);
      return (await response.json() as {data:{operations:Array<{operation:string;operationRef:string}>}}).data.operations;
    };
    const oldManifest=await directManifest();
    const query=oldManifest.find(op=>op.operation==="query")!;
    expect(query).toBeDefined();
    expect(oldManifest.some(op=>op.operation==="create")).toBe(false);
    expect((await f.accountRequest("PUT",managePath,{maxAccess:"none"},manager)).status).toBe(204);
    expect((await approve(pending)).status).toBe(403);
    expect(await f.db.prepare("SELECT COUNT(*) n FROM authorization_request_delegations WHERE request_id=?").bind(pending).first("n")).toBe(0);
    expect((await f.request("POST",records,represented,{name:"Denied"},headers)).status).toBe(403);
    expect(await count()).toBe(beforeCount);
    // The direct OAuth Agent uses its own explicit read Grant, not User authority.
    expect(await directManifest()).toEqual(oldManifest);
    expect((await f.request("POST",base+"/_operations/"+query.operationRef+"/invoke",patch,
      {arguments:{spaceId:f.space,data:{page:{limit:1}}}})).status).toBe(200);
    expect((await f.request("POST",records,patch,{name:"No independent write grant"})).status).toBe(403);
    expect((await f.accountRequest("DELETE",managePath,undefined,manager)).status).toBe(204);
    expect((await approve(pending)).status).toBe(200);
    expect((await f.request("POST",records,represented,{name:"Restored"},headers)).status).toBe(201);
    expect(await count()).toBe(beforeCount+1);
  });

  it("separates non-authorizing delegation eligibility from independent direct Grant and current User authority",async()=>{
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    const discovery=base+"/_discovery/operations";
    const eligibility=discovery+"?mode=delegation_request";
    const now=new Date().toISOString();
    f.setDelegationEnabled(true);
    await f.setServerOperations(["query","get","create"]);
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+crypto.randomUUID().replaceAll("-",""),f.space,f.oauthUser,now,now),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'").bind(f.application),
    ]);
    const claims={oauth_allow_user_authorization:true};
    const direct=await f.request("GET",discovery,claims);
    expect(direct.status).toBe(200);
    const old=(await direct.json() as {data:{operations:Array<{operation:string;operationRef:string}>}}).data.operations.find(op=>op.operation==="query")!;
    expect(old).toBeDefined();
    await f.db.prepare("DELETE FROM data_grants WHERE grantee_id=? AND grantee_type='agent'").bind(f.agent).run();
    const without=await f.request("GET",discovery,claims);
    expect(without.status).toBe(200);
    expect((await without.json() as {data:{operations:unknown[]}}).data.operations).toEqual([]);
    const preview=await f.request("GET",eligibility,claims);
    expect(preview.status).toBe(200);
    expect((await preview.json() as {data:unknown}).data).toEqual({eligibleOperations:[
      {modelKey:"task",operation:"query",requiredScopes:["resources:read"]},
      {modelKey:"task",operation:"get",requiredScopes:["resources:read"]},
    ]});
    // A protocol-neutral Authority route provides the same metadata-only
    // eligibility without exposing executable operationRefs or User data.
    const authority=base+"/_authority/delegation-eligibility";
    const canonical=await f.request("GET",authority,claims);
    expect(canonical.status).toBe(200);
    expect((await canonical.json() as {data:unknown}).data).toEqual({eligibleOperations:[
      {modelKey:"task",operation:"get",requiredScopes:["resources:read"]},
      {modelKey:"task",operation:"query",requiredScopes:["resources:read"]},
    ]});
    const narrowed=await f.request("GET",authority+"?modelKey=task&operation=query",claims);
    expect((await narrowed.json() as {data:unknown}).data).toEqual({eligibleOperations:[
      {modelKey:"task",operation:"query",requiredScopes:["resources:read"]},
    ]});
    expect((await f.request("GET",authority+"?userId="+f.oauthUser,claims)).status).toBe(400);
    expect((await f.request("GET",authority+"?modelKey=task&operation=create",claims)).status).toBe(200);
    // Current Identity introspection denies mismatched consent before route dispatch.
    expect((await f.request("GET",authority)).status).toBe(401);
    expect((await f.request("GET",authority.replace(f.space,f.other),claims)).status).toBe(403);
    await f.setServerEnabled(false);
    expect((await f.request("GET",authority,claims)).status).toBe(403);
    await f.setServerEnabled(true);
    expect((await f.request("POST",base+"/_operations/"+old.operationRef+"/invoke",claims,
      {arguments:{spaceId:f.space,data:{page:{limit:1}}}})).status).toBe(404);
    expect((await f.request("GET",eligibility+"&mode=delegation_request",claims)).status).toBe(400);
    expect((await f.request("GET",eligibility+"&operation=query",claims)).status).toBe(400);
    expect((await f.request("GET","/api/v1/spaces/"+f.other+"/_discovery/operations?mode=delegation_request",claims)).status).toBe(403);
    const pending=await f.request("POST",base+"/oauth-delegation-requests",claims,{
      modelKey:"task",operation:"query",reason:"Read under explicit User approval",
    });
    expect(pending.status).toBe(201);
    const id=(await pending.json() as {data:{id:string}}).data.id;
    const approved=await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+id+"/approve",{mode:"until_revoked"});
    expect(approved.status).toBe(200);
    const dlg=(await approved.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const represented={...claims,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg};
    const headers={"x-lifespace-delegation-id":dlg};
    const query=base+"/models/task/records/query";
    // OAuth-approved exact operation cannot be replayed through an opaque
    // trusted Agent credential, even by the same Agent/Application.
    expect((await f.opaqueAgentRequest("POST",query,dlg,{page:{limit:1}})).status).toBe(403);
    for(let i=0;i<2;i++)expect((await f.request("POST",query,represented,{page:{limit:1}},headers)).status).toBe(200);
    expect((await f.accountRequest("POST","/api/v1/me/oauth/delegations/"+dlg+"/revoke",{})).status).toBe(200);
    expect((await f.request("POST",query,represented,{page:{limit:1}},headers)).status).toBe(403);
    await f.db.prepare("UPDATE space_memberships SET deleted_at=? WHERE space_id=? AND user_id=?").bind(now,f.space,f.oauthUser).run();
    const reduced=await f.request("GET",eligibility,claims);
    expect(reduced.status).toBe(200);
    expect((await reduced.json() as {data:unknown}).data).toEqual({eligibleOperations:[]});
    f.setDelegationEnabled(false);
    expect((await f.request("GET",eligibility)).status).toBe(404);
  });
  it("previews only the currently approved exact operation contract without consuming a single use", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    const discovery=base+"/_discovery/operations";
    const now=new Date().toISOString();
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    await f.setServerOperations(["get","create","update"]);
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+crypto.randomUUID().replaceAll("-",""),f.space,f.oauthUser,now,now),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'").bind(f.application),
      f.db.prepare("DELETE FROM data_grants WHERE grantee_id=? AND grantee_type='agent'").bind(f.agent),
    ]);
    const actor={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    const narrow=discovery+"?modelKey=task&operation=update";
    const direct=await f.request("GET",narrow,actor);
    expect((await direct.json() as {data:{operations:unknown[]}}).data.operations).toEqual([]);
    const request=await f.request("POST",base+"/oauth-delegation-requests",actor,{
      operations:["create","get","update"].map(operation=>({modelKey:"task",operation})),
      reason:"Synthetic contract preview and exact patch",
    });
    expect(request.status).toBe(201);
    const id=(await request.json() as {data:{id:string}}).data.id;
    const approval=await f.accountRequest("POST","/api/v1/me/oauth/delegation-requests/"+id+"/approve",{});
    expect(approval.status).toBe(200);
    const [create,get,update]=(await approval.json() as {data:{delegations:Array<{id:string}>}}).data.delegations.map(d=>d.id);
    const represented=(dlg:string)=>({...actor,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:dlg});
    const header=(dlg:string)=>({"x-lifespace-delegation-id":dlg});
    const preview=await f.request("GET",narrow,represented(update!),undefined,header(update!));
    expect(preview.status).toBe(200);
    const rows=(await preview.json() as {data:{operations:Array<{modelKey:string;operation:string;inputSchema:{properties:{data:{$ref:string}};$defs:Record<string,{required:string[];properties:Record<string,unknown>}>}}>} }).data.operations;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({modelKey:"task",operation:"update"});
    const schema=rows[0]!.inputSchema;
    const fields=schema.$defs[schema.properties.data.$ref.slice(8)]!;
    expect(fields.required).toContain("version");
    expect(fields.properties).toHaveProperty("name");
    for(const path of [discovery,discovery+"?modelKey=task",discovery+"?modelKey=task&operation=create",narrow+"&mode=delegation_request",narrow+"&operation=update"]) {
      expect((await f.request("GET",path,represented(update!),undefined,header(update!))).status).toBe(404);
    }
    expect((await f.request("GET",narrow,represented(get!),undefined,header(get!))).status).toBe(404);
    const records=base+"/models/task/records";
    const created=await f.request("POST",records,represented(create!),{name:"Synthetic original"},header(create!));
    expect(created.status).toBe(201);
    const record=(await created.json() as {data:{id:string;version:number}}).data;
    const missing=await f.request("PATCH",records+"/"+record.id,represented(update!),{name:"Synthetic correction"},header(update!));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({error:{code:"INVALID_REQUEST",details:{fieldPath:"data.version",reasonCode:"FIELD_REQUIRED"}}});
    const patched=await f.request("PATCH",records+"/"+record.id,represented(update!),{version:record.version,name:"Synthetic correction"},header(update!));
    expect(patched.status).toBe(200);
    const current=await f.request("GET",records+"/"+record.id,represented(get!),undefined,header(get!));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({data:{id:record.id,version:record.version+1,name:"Synthetic correction"}});
    const consumed=await f.request("GET",narrow,represented(update!),undefined,header(update!));
    expect(consumed.status).toBe(200);
    expect((await consumed.json() as {data:{operations:unknown[]}}).data.operations).toEqual([]);
  });

  it("Account User can grant bounded repeated / long-lived exact operation and revoke without OAuth consent", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space+"/models/task/records";
    const requests="/api/v1/spaces/"+f.space+"/oauth-delegation-requests";
    const now=new Date().toISOString();
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    await f.setServerOperations(["query","get","create"]);
    await f.db.batch([
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+crypto.randomUUID().replaceAll("-",""),f.space,f.oauthUser,now,now),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'")
        .bind(f.application),
    ]);
    const actor={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    const issue=async()=>{
      const result=await f.request("POST",requests,actor,{
        modelKey:"task",operation:"create",reason:"Repeated governed task creation",
      });
      expect(result.status).toBe(201);
      return (await result.json() as {data:{id:string}}).data.id;
    };
    const approvalPath=(id:string)=>"/api/v1/me/oauth/delegation-requests/"+id+"/approve";
    const first=await issue();
    for(const bad of [{mode:"timed",durationMinutes:30},{mode:"until_revoked",durationMinutes:60},
      {mode:"timed",durationMinutes:"60"},{mode:"admin"}]){
      expect((await f.accountRequest("POST",approvalPath(first),bad)).status).toBe(400);
    }
    const timed=await f.accountRequest("POST",approvalPath(first),{mode:"timed",durationMinutes:60});
    expect(timed.status).toBe(200);
    const timedId=(await timed.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const timedRow=await f.db.prepare("SELECT max_uses,expires_at FROM delegations WHERE id=?")
      .bind(timedId).first<{max_uses:number|null;expires_at:string|null}>();
    expect(timedRow?.max_uses).toBeNull();
    expect(Date.parse(timedRow!.expires_at!)).toBeGreaterThan(Date.now());
    const delegated=(id:string)=>({...actor,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:id});
    const header=(id:string)=>({"x-lifespace-delegation-id":id});
    expect((await f.request("POST",base,delegated(timedId),{name:"Timed first"},header(timedId))).status).toBe(201);
    expect((await f.request("POST",base,delegated(timedId),{name:"Timed second"},header(timedId))).status).toBe(201);
    expect((await f.request("POST",base+"/query",delegated(timedId),{limit:1},header(timedId))).status).toBe(404);
    // Expiry is a current-state authority check; the same signed delegation cannot extend it.
    await f.db.prepare("UPDATE delegations SET expires_at=? WHERE id=?")
      .bind("2020-01-01T00:00:00.000Z",timedId).run();
    expect((await f.request("POST",base,delegated(timedId),{name:"After expiry"},header(timedId))).status).toBe(403);

    const second=await issue();
    const indefinite=await f.accountRequest("POST",approvalPath(second),{mode:"until_revoked"});
    expect(indefinite.status).toBe(200);
    const longId=(await indefinite.json() as {data:{delegations:Array<{id:string}>}}).data.delegations[0]!.id;
    const longRow=await f.db.prepare("SELECT max_uses,expires_at FROM delegations WHERE id=?")
      .bind(longId).first<{max_uses:number|null;expires_at:string|null}>();
    expect(longRow?.max_uses).toBeNull();
    expect(longRow?.expires_at).toBeNull();
    const listed=await f.accountRequest("GET","/api/v1/me/oauth/delegations");
    expect(listed.status).toBe(200);
    const listData=await listed.json() as {data:{items:Array<{id:string;mode:string}>}};
    expect(listData.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({id:longId,mode:"until_revoked"}),
    ]));
    expect((await f.accountRequest("POST","/api/v1/me/oauth/delegations/"+longId+"/revoke",{},"usr_other")).status).toBe(404);
    expect((await f.request("POST",base,delegated(longId),{name:"Long first"},header(longId))).status).toBe(201);
    expect((await f.request("POST",base,delegated(longId),{name:"Long second"},header(longId))).status).toBe(201);
    f.setActive(false);
    // A revoked OAuth Authorization must block execution, but never block User revocation.
    expect((await f.request("POST",base,delegated(longId),{name:"OAuth revoked"},header(longId))).status).toBe(401);
    const revoked=await f.accountRequest("POST","/api/v1/me/oauth/delegations/"+longId+"/revoke",{});
    expect(revoked.status).toBe(200);
    expect((await f.accountRequest("POST","/api/v1/me/oauth/delegations/"+longId+"/revoke",{})).status).toBe(404);
    const noLong=await f.accountRequest("GET","/api/v1/me/oauth/delegations");
    expect((await noLong.json() as {data:{items:Array<{id:string}>}}).data.items.some(x=>x.id===longId)).toBe(false);
  });

  it("Account-approved Person Delegation uses only narrow Person Authority and atomically consumes each use", async () => {
    const f=await fixture();
    const personBase="/api/v1/spaces/"+f.space+"/people";
    const requests="/api/v1/spaces/"+f.space+"/oauth-delegation-requests";
    const now=new Date().toISOString();
    f.setDelegationEnabled(true);
    f.setConsentScopes(["resources:read","resources:write"]);
    await f.db.batch([
      f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
        .bind(JSON.stringify({models:[],resources:[{resourceKey:"person_directory",
          operations:["list","get","create","update","delete"]}]}),f.serverId),
      f.db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)")
        .bind("mem_"+crypto.randomUUID().replaceAll("-",""),f.space,f.oauthUser,now,now),
    ]);
    const actor={scope:"resources:read resources:write",oauth_allow_user_authorization:true};
    const approve=async(operation:string)=>{
      const applied=await f.request("POST",requests,actor,{
        modelKey:"person",operation,reason:"User approves exactly one Person operation",
      });
      expect(applied.status).toBe(201);
      const pending=await applied.json() as {data:{id:string;approvalUrl:string}};
      expect(pending.data.approvalUrl).toContain("/delegation?request_id="+pending.data.id);
      expect((await f.trustedRequest("POST",
        "/api/v1/spaces/"+f.space+"/authorization-requests/"+pending.data.id+"/confirm",
        {principalUserId:f.oauthUser})).status).toBe(404);
      expect((await f.accountRequest("POST",
        "/api/v1/me/oauth/delegation-requests/"+pending.data.id+"/approve",{},"usr_unrelated")).status).toBe(404);
      const granted=await f.accountRequest("POST",
        "/api/v1/me/oauth/delegation-requests/"+pending.data.id+"/approve",{});
      expect(granted.status).toBe(200);
      const body=await granted.json() as {data:{delegations:Array<{id:string}>}};
      const id=body.data.delegations[0]!.id;
      const narrow=await f.db.prepare("SELECT target_type,target_id,max_access FROM delegation_scopes WHERE delegation_id=?")
        .bind(id).first<{target_type:string;target_id:string;max_access:string}>();
      expect(narrow).toMatchObject({target_type:"model",target_id:"person_directory",
        max_access:["query","get"].includes(operation)?"read":"write"});
      return {id,claims:{...actor,principal_type:"user",principal_id:f.oauthUser,oauth_delegation_id:id},
        headers:{"x-lifespace-delegation-id":id}};
    };
    const create=await approve("create");
    const made=await f.request("POST",personBase,create.claims,
      {displayName:"Synthetic One",alternateNames:["Alias"]},create.headers);
    expect(made.status).toBe(201);
    const created=await made.json() as {data:{id:string;version:number}};
    expect(created.data.id).toMatch(/^per_/u);
    const change=await f.db.prepare("SELECT principal_type,principal_id,actor_type,actor_id,delegation_id FROM space_person_changes WHERE person_id=? AND operation='create'")
      .bind(created.data.id).first<Record<string,string>>();
    expect(change).toMatchObject({principal_type:"user",principal_id:f.oauthUser,actor_type:"agent",
      actor_id:f.agent,delegation_id:create.id});
    expect((await f.request("POST",personBase,create.claims,{displayName:"Replay"},create.headers)).status).toBe(403);
    expect((await f.request("POST","/api/v1/spaces/"+f.space+"/models/task/records",
      create.claims,{name:"Must never inherit Task rights"},create.headers)).status).toBe(404);

    const query=await approve("query");
    expect((await f.request("GET",personBase+"?q=Synthetic",query.claims,undefined,query.headers)).status).toBe(200);
    expect((await f.request("GET",personBase,query.claims,undefined,query.headers)).status).toBe(403);
    const get=await approve("get");
    expect((await f.request("GET",personBase+"/"+created.data.id,get.claims,undefined,get.headers)).status).toBe(200);
    expect((await f.request("GET",personBase+"/"+created.data.id,get.claims,undefined,get.headers)).status).toBe(403);
    const update=await approve("update");
    const edited=await f.request("PATCH",personBase+"/"+created.data.id,update.claims,
      {version:created.data.version,displayName:"Synthetic Updated"},update.headers);
    expect(edited.status).toBe(200);
    expect((await f.request("PATCH",personBase+"/"+created.data.id,update.claims,
      {version:created.data.version,displayName:"Replay"},update.headers)).status).toBe(403);
    const next=await edited.json() as {data:{version:number}};
    const del=await approve("delete");
    expect((await f.request("DELETE",personBase+"/"+created.data.id,del.claims,
      {version:next.data.version},del.headers)).status).toBe(204);
    expect((await f.request("DELETE",personBase+"/"+created.data.id,del.claims,
      {version:next.data.version},del.headers)).status).toBe(403);

    // Unavailable or revoked Person authority cannot be approved.
    await f.db.prepare("DELETE FROM space_memberships WHERE user_id=? AND space_id=?")
      .bind(f.oauthUser,f.space).run();
    const pending=await f.request("POST",requests,actor,{
      modelKey:"person",operation:"create",reason:"Request after Person authority revoked",
    });
    expect(pending.status).toBe(201);
    const p=await pending.json() as {data:{id:string}};
    expect((await f.accountRequest("POST",
      "/api/v1/me/oauth/delegation-requests/"+p.data.id+"/approve",{})).status).toBe(403);
  });

  it("projects ordinary model operations through one opaque Core tool catalog and rechecks on invocation", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    const preview=await f.request("GET",base+"/_discovery/operations");
    expect(preview.status).toBe(200);
    const data=await preview.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;inputSchema:Record<string,unknown>;
    }>}};
    const query=data.data.operations.find(x=>x.modelKey==="task"&&x.operation==="query");
    expect(query).toBeDefined();
    expect(query?.operationRef).toMatch(/^op_[a-f0-9]{64}$/u);
    expect(JSON.stringify(data)).not.toMatch(/"origin"|"provider"|"person_directory"/u);
    const route=base+"/_operations/"+query!.operationRef+"/invoke";
    const result=await f.request("POST",route,{},{
      arguments:{spaceId:f.space,data:{page:{limit:1}}},
    });
    expect(result.status).toBe(200);
    const forged=await f.request("POST",route,{},{
      arguments:{spaceId:f.other,data:{}},
    });
    expect(forged.status).toBe(404);
    expect((await f.request("GET",
      "/api/v1/spaces/"+f.other+"/_discovery/operations")).status).toBe(403);
    f.setActive(false);
    expect((await f.request("POST",route,{},{
      arguments:{spaceId:f.space,data:{}},
    })).status).toBe(401);
  });

  it("batches current discovery authority and resolves only the invoked model, with request-correlated D1 timing", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    await f.db.batch([
      f.db.prepare("UPDATE data_grants SET permission='write' WHERE source_space_id=? AND grantee_id=?").bind(f.space,f.agent),
      f.db.prepare("UPDATE application_model_access SET max_access='write' WHERE application_id=?").bind(f.application),
      ...["event","wish"].map(key=>f.db.prepare(
        "INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)"
      ).bind(f.application,key,"write","service","svc_synthetic")),
      f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?").bind(
        JSON.stringify({models:["task","event","wish"].map(modelKey=>({modelKey,operations:["query","get","create"]}))}),f.serverId),
    ]);
    const log=vi.spyOn(console,"log").mockImplementation(()=>undefined);
    try{
      f.resetAuthorityMetrics();
      const catalog=await f.request("GET",base+"/_discovery/operations");
      expect(catalog.status).toBe(200);
      const rows=(await catalog.json() as {data:{operations:Array<{modelKey:string;operation:string;operationRef:string}>}}).data.operations;
      expect(rows.filter(x=>x.operation==="create").map(x=>x.modelKey).sort()).toEqual(["event","task","wish"]);
      // Read and write use one current snapshot per model in a single batch.
      expect(f.authorityMetrics()).toEqual({statements:3,batches:[3]});
      f.resetAuthorityMetrics();
      const narrow=await f.request("GET",base+"/_discovery/operations?modelKey=task&operation=query");
      expect(narrow.status).toBe(200);
      const narrowed=(await narrow.json() as {data:{operations:typeof rows}}).data.operations;
      expect(narrowed.map(x=>[x.modelKey,x.operation])).toEqual([["task","query"]]);
      expect(f.authorityMetrics()).toEqual({statements:1,batches:[1]});
      const unknown=await f.request("GET",base+"/_discovery/operations?modelKey=unknown&operation=query");
      expect(unknown.status).toBe(200);
      expect((await unknown.json() as {data:{operations:unknown[]}}).data.operations).toEqual([]);
      for(const params of ["operation=query","modelKey=task&modelKey=event","modelKey=task&operation=invalid","modelKey=task&other=1"]){
        expect((await f.request("GET",base+"/_discovery/operations?"+params)).status).toBe(400);
      }
      const selected=rows.find(x=>x.modelKey==="task"&&x.operation==="query")!;
      expect(selected).toBeDefined();
      const route=base+"/_operations/"+selected.operationRef+"/invoke";
      f.resetAuthorityMetrics();
      const invoked=await f.request("POST",route,{},{
        arguments:{spaceId:f.space,data:{page:{limit:1}}},
      });
      expect(invoked.status).toBe(200);
      // One target projection, then independent canonical execution; unrelated
      // configured models must not incur authority SQL or schema projection.
      expect(f.authorityMetrics()).toEqual({statements:2,batches:[1,1]});
      const operationLogs=log.mock.calls.map(([value])=>{
        try{return JSON.parse(String(value));}catch{return null;}
      }).filter(value=>value?.message==="LifeSpace performance timing");
      const discovery=operationLogs.find(value=>value.path===base+"/_discovery/operations"&&value.status===200);
      expect(discovery?.phases).toEqual(expect.objectContaining({
        "security.oauth_execution_state":expect.any(Number),
        "security.oauth_server_policy":expect.any(Number),
        "operation.discovery":expect.any(Number),
      }));
      const invocation=operationLogs.find(value=>value.path===route&&value.status===200);
      expect(invocation?.phases).toEqual(expect.objectContaining({
        "security.oauth_execution_state":expect.any(Number),
        "security.oauth_server_policy":expect.any(Number),
        "operation.target_projection":expect.any(Number),
        "operation.canonical_execution":expect.any(Number),
      }));
      log.mockClear();
      const requestId="perf-authority-synthetic";
      const direct=await f.request("POST",base+"/models/task/records/query",{},{
        page:{limit:1},
      },{"x-request-id":requestId});
      expect(direct.status).toBe(200);
      const timings=log.mock.calls.map(([value])=>{
        try{return JSON.parse(String(value));}catch{return null;}
      }).filter(value=>value?.message==="LifeSpace performance timing"&&value.requestId===requestId);
      expect(timings).toHaveLength(1);
      expect(timings[0].authorityD1).toEqual([expect.objectContaining({
        wallMs:expect.any(Number),statements:1,success:true,
        regions:expect.any(Array),colos:expect.any(Array),
      })]);
      // Old operation reference remains non-authorizing after current Grant loss.
      await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE source_space_id=? AND grantee_id=?")
        .bind(new Date().toISOString(),f.space,f.agent).run();
      const hidden=await f.request("GET",base+"/_discovery/operations?modelKey=task&operation=query");
      expect(hidden.status).toBe(200);
      expect((await hidden.json() as {data:{operations:unknown[]}}).data.operations).toEqual([]);
      expect((await f.request("POST",route,{},{
        arguments:{spaceId:f.space,data:{page:{limit:1}}},
      })).status).toBe(404);
    }finally{log.mockRestore();}
  });

  it("discovers and runs Native create through the same opaque operation contract, with current server policy", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    await f.db.prepare(
      "UPDATE data_grants SET permission='write' WHERE source_space_id=? AND grantee_type='agent' AND grantee_id=? AND resource_type='space'"
    ).bind(f.space,f.agent).run();
    await f.db.prepare(
      "UPDATE application_model_access SET max_access='write' WHERE application_id=? AND model_key='task'"
    ).bind(f.application).run();
    await f.setServerOperations(["query","create"]);
    f.setConsentScopes(["resources:read","resources:write"]);
    const claims={scope:"resources:read resources:write"};
    const readOnly={scope:"resources:read"};
    // Discoverability and executability differ: existing Agent write Grants
    // may be advertised for an explicit OAuth Scope upgrade, but a read token
    // must never execute a mutation.
    const previewRead=await f.request("GET",base+"/_discovery/operations",readOnly);
    expect(previewRead.status).toBe(200);
    const readCatalog=await previewRead.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;requiredScopes:string[];
    }>}};
    const pendingWrite=readCatalog.data.operations.find(x=>x.modelKey==="task"&&x.operation==="create");
    expect(pendingWrite?.requiredScopes).toEqual(["resources:read","resources:write"]);
    const beforeRead=await f.request("GET",base+"/_discovery/operations",readOnly);
    expect(beforeRead.status).toBe(200);
    expect((await f.request("POST",base+"/_operations/"+pendingWrite!.operationRef+"/invoke",readOnly,{
      arguments:{spaceId:f.space,data:{name:"Must not write with only read Scope"}},
    })).status).toBe(403);
    const projected=await f.request("GET",base+"/_discovery/operations",claims);
    expect(projected.status).toBe(200);
    const body=await projected.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;requiredScopes:string[];inputSchema:{
        properties:Record<string,unknown>;$defs?:Record<string,unknown>;
      };
    }>}};
    const create=body.data.operations.find(o=>o.modelKey==="task"&&o.operation==="create");
    expect(create).toBeDefined();
    expect(create?.requiredScopes).toEqual(["resources:read","resources:write"]);
    expect(create?.inputSchema.properties.data).toMatchObject({$ref:expect.stringMatching(/^#\/\$defs\//u)});
    expect(create?.inputSchema.$defs).toBeDefined();
    const mutation=await f.request("POST",base+"/_operations/"+create!.operationRef+"/invoke",claims,{
      arguments:{spaceId:f.space,data:{name:"Synthetic operation created"}},
    });
    expect(mutation.status).toBe(201);
    const created=await mutation.json() as {data:{id:string}};
    expect(created.data.id).toMatch(/^rec_/u);
    await f.setServerOperations(["query"]);
    expect((await f.request("POST",base+"/_operations/"+create!.operationRef+"/invoke",claims,{
      arguments:{spaceId:f.space,data:{name:"Stale operation"}},
    })).status).toBe(404);
  });

  it("exposes Kernel Person through the exact same generic operation envelope as a normal Model", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    await f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
      .bind(JSON.stringify({models:[],resources:[{resourceKey:"person_directory",operations:["list","get","create"]}]}),f.serverId).run();
    await f.db.prepare(
      "INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) "+
      "VALUES(?,?,'agent',?,'person_directory',NULL,'write',?,?)"
    ).bind("grt_person_"+crypto.randomUUID().replaceAll("-",""),f.space,f.agent,"usr_synthetic",new Date().toISOString()).run();
    f.setConsentScopes(["resources:read","resources:write"]);
    const patch={scope:"resources:read resources:write"};
    const previewRead=await f.request("GET",base+"/_discovery/operations",{scope:"resources:read"});
    expect(previewRead.status).toBe(200);
    const personPreview=await previewRead.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;requiredScopes:string[];
    }>}};
    const personCreate=personPreview.data.operations.find(x=>x.modelKey==="person"&&x.operation==="create");
    expect(personCreate?.requiredScopes).toEqual(["resources:read","resources:write"]);
    expect((await f.request("POST",base+"/_operations/"+personCreate!.operationRef+"/invoke",
      {scope:"resources:read"},{arguments:{spaceId:f.space,data:{displayName:"Read must not create"}}})).status).toBe(403);
    const preview=await f.request("GET",base+"/_discovery/operations",patch);
    expect(preview.status).toBe(200);
    const found=await preview.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;inputSchema:unknown;
    }>}};
    const tools=found.data.operations;
    expect(tools.map(x=>x.operation)).toContain("query");
    const create=tools.find(x=>x.modelKey==="person"&&x.operation==="create")!;
    expect(create.operationRef).toMatch(/^op_[a-f0-9]{64}$/u);
    expect(JSON.stringify(found)).not.toContain("person_directory");
    expect(JSON.stringify(found)).not.toContain("external");
    const made=await f.request("POST",base+"/_operations/"+create.operationRef+"/invoke",patch,{
      arguments:{spaceId:f.space,data:{displayName:"Synthetic Person"}},
    });
    expect(made.status).toBe(201);
    const created=await made.json() as {data:{id:string;displayName:string}};
    expect(created.data).toMatchObject({displayName:"Synthetic Person"});
    expect(created.data.id).toMatch(/^per_/u);
    expect((await f.request("POST",base+"/_operations/"+create.operationRef+"/invoke",patch,{
      arguments:{spaceId:f.other,data:{displayName:"Cross Space"}},
    })).status).toBe(404);
  });

  it("does not advertise Person update from OAuth write Scope plus a read-only Person Grant", async () => {
    const f=await fixture();
    const base="/api/v1/spaces/"+f.space;
    await f.db.prepare("UPDATE mcp_server_definitions SET config_json=? WHERE id=?")
      .bind(JSON.stringify({models:[],resources:[{resourceKey:"person_directory",
        operations:["list","get","update"]}]}),f.serverId).run();
    const grantId="grt_person_"+crypto.randomUUID().replaceAll("-","");
    await f.db.prepare(
      "INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) "+
      "VALUES(?,?,'agent',?,'person_directory',NULL,'read',?,?)"
    ).bind(grantId,f.space,f.agent,"usr_synthetic",new Date().toISOString()).run();
    f.setConsentScopes(["resources:read","resources:write"]);
    const patch={scope:"resources:read resources:write"};
    const preview=await f.request("GET",base+"/_discovery/operations",patch);
    expect(preview.status).toBe(200);
    const before=await preview.json() as {data:{operations:Array<{operation:string;modelKey:string}>}};
    expect(before.data.operations.filter(op=>op.modelKey==="person").map(op=>op.operation))
      .toEqual(["query","get"]);
    // The opposite direction is also important: a token with write Scope
    // does not advertise any ungranted Person write operation.
    const readTokenBefore=await f.request("GET",base+"/_discovery/operations",{scope:"resources:read"});
    expect(readTokenBefore.status).toBe(200);
    const readOnlyPerson=await readTokenBefore.json() as {data:{operations:Array<{operation:string;modelKey:string}>}};
    expect(readOnlyPerson.data.operations.filter(op=>op.modelKey==="person").map(op=>op.operation))
      .toEqual(["query","get"]);
    await f.db.prepare("UPDATE data_grants SET permission='write' WHERE id=?").bind(grantId).run();
    const after=await f.request("GET",base+"/_discovery/operations",patch);
    expect(after.status).toBe(200);
    const eligible=await after.json() as {data:{operations:Array<{operation:string;modelKey:string}>}};
    expect(eligible.data.operations.filter(op=>op.modelKey==="person").map(op=>op.operation))
      .toEqual(["query","get","update"]);
  });

  it("rejects unknown configured MCP Server and pre-v7 unscoped /mcp resources", async () => {
    const f = await fixture();
    const missing = "https://resource.example.test/mcp/mcp_" + "e".repeat(32);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory", { oauth_resource: missing })).status).toBe(403);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory", { oauth_resource: "https://resource.example.test/mcp" })).status).toBe(401);
  });

});
