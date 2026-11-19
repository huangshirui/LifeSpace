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
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function userToken(privateKey: string, userId: string, applicationId="test-app") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: applicationId,
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function identityBinding(agentId: string, state: { active: boolean; scopes: string[] }, applicationId="test-app"): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.endsWith("/introspection/v1/agent-credentials")) return new Response("not found", { status: 404 });
      return Response.json({
        data: state.active
          ? {
              active: true,
              audience: "lifespace-core",
              principal: {
                type: "agent",
                id: agentId,
                displayName: "Adapter Agent",
                clientId: applicationId,
                scopes: state.scopes,
                tokenId: "agc_test",
                purpose: "agent_api",
              },
            }
          : { active: false },
      });
    },
  } as Fetcher;
}

async function request(path: string, options: RequestInit, publicKey: string, identity: Fetcher) {
  return createApp().request(`http://core.test${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    IDENTITY: identity,
    CORE_IDENTITY_SHARED_SECRET: "core-secret",
    ENVIRONMENT: "test",
    MCP_PUBLIC_ORIGIN:"https://core.example.test",
  });
}

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const timestamp = new Date().toISOString();
  await db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?)")
    .bind(spaceId, "Agent Credential", userId, timestamp, timestamp).run();
  await db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", timestamp, timestamp).run();
  await db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", timestamp, timestamp).run();
  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES('test-app','event','write','user',?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access='write'`).bind(userId).run();
}

function jsonData(response: Response) {
  return response.json<any>().then((payload) => payload.data);
}

describe("opaque Agent API credential execution", () => {
  it("projects and invokes trusted MCP operations with no Agent Grant and an explicit current Delegation",async()=>{
    const {privateKey,publicKey}=await keys();
    const uuid=crypto.randomUUID().replaceAll("-","");
    const userId="usr_"+uuid,agentId="agt_"+uuid,spaceId="spc_"+uuid,applicationId="app_"+uuid,serverId="mcp_"+uuid;
    const resource="https://core.example.test/mcp/"+serverId,now=new Date().toISOString();
    const db=(env as unknown as TestEnv).DB;
    await seed(userId,spaceId);
    await db.batch([
      db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?, 'event','read','user',?)").bind(applicationId,userId),
      db.prepare("INSERT INTO mcp_server_definitions(id,display_name,description,enabled,config_json,revision,created_by_user_id,updated_by_user_id,created_at,updated_at) VALUES(?,?,?,1,?,1,?,?,?,?)")
        .bind(serverId,"Trusted MCP","",JSON.stringify({models:[{modelKey:"event",operations:["query","get","create"]}],
          delegationContexts:[{spaceId,applicationId,agentId}]}),userId,userId,now,now),
    ]);
    const state={active:true,scopes:["resources:read"]};
    const identity=identityBinding(agentId,state,applicationId);
    const directUser=await userToken(privateKey,userId,applicationId);
    const base="/api/v1/spaces/"+spaceId;
    const issued=await request(base+"/delegations",{method:"POST",headers:{authorization:"Bearer "+directUser,"content-type":"application/json"},
      body:JSON.stringify({actor:{type:"agent",id:agentId},scope:{target:{type:"model",id:"event"},maxAccess:"read"}})},publicKey,identity);
    expect(issued.status).toBe(201);
    const dlg=(await jsonData(issued)).id;
    const headers={authorization:"Bearer lsp_agt_test_credential","x-lifespace-mcp-resource":resource,"x-lifespace-delegation-id":dlg};
    const discover=()=>request(base+"/_discovery/operations",{headers},publicKey,identity);
    expect((await request(base+"/_discovery/operations",{headers:{...headers,"x-lifespace-delegation-id":"dlg_invalid"}},publicKey,identity)).status).toBe(403);
    expect((await request(base+"/_discovery/operations",{headers:{authorization:headers.authorization,"x-lifespace-mcp-resource":resource}},publicKey,identity)).status).toBe(403);
    const listed=await discover();
    expect(listed.status).toBe(200);
    const operations=(await jsonData(listed)).operations;
    expect(operations.map((row:{operation:string})=>row.operation)).toEqual(["query","get"]);
    const invoke=()=>request(base+"/_operations/"+operations[0].operationRef+"/invoke",{method:"POST",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({arguments:{spaceId,data:{page:{limit:1}}}})},publicKey,identity);
    expect((await invoke()).status).toBe(200);
    expect((await invoke()).status).toBe(200);
    await db.prepare("UPDATE mcp_server_definitions SET enabled=0 WHERE id=?").bind(serverId).run();
    expect((await invoke()).status).toBe(403);
    await db.prepare("UPDATE mcp_server_definitions SET enabled=1 WHERE id=?").bind(serverId).run();
    await db.prepare("UPDATE delegations SET revoked_at=? WHERE id=?").bind(now,dlg).run();
    expect((await invoke()).status).toBe(403);
    expect((await discover()).status).toBe(403);
  });
  it("derives represented User only from dlg_* and preserves User/Agent Change attribution", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const state = { active: true, scopes: ["resources:read", "resources:write"] };
    const identity = identityBinding(agentId, state);
    const directUser = await userToken(privateKey, userId);

    const delegationResponse = await request(`/api/v1/spaces/${spaceId}/delegations`, {
      method: "POST",
      headers: { authorization: `Bearer ${directUser}`, "content-type": "application/json" },
      body: JSON.stringify({ actor: { type: "agent", id: agentId }, scope: { target: { type: "model", id: "event" }, maxAccess: "write" } }),
    }, publicKey, identity);
    expect(delegationResponse.status).toBe(201);
    const delegation = await jsonData(delegationResponse);

    const noDelegation = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: { authorization: "Bearer lsp_agt_test_credential", "content-type": "application/json" },
      body: JSON.stringify({ summary: "must not use User authority", when: { kind: "date", start: "2026-10-05", endExclusive: "2026-10-06" } }),
    }, publicKey, identity);
    expect(noDelegation.status).toBe(403);

    const createdResponse = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: {
        authorization: "Bearer lsp_agt_test_credential",
        "x-lifespace-delegation-id": delegation.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "opaque agent represented user", when: { kind: "date", start: "2026-10-05", endExclusive: "2026-10-06" } }),
    }, publicKey, identity);
    expect(createdResponse.status).toBe(201);
    const created = await jsonData(createdResponse);

    const history = await request(`/api/v1/spaces/${spaceId}/changes?recordId=${created.id}`, {
      headers: { authorization: `Bearer ${directUser}` },
    }, publicKey, identity);
    expect(history.status).toBe(200);
    const changes = await jsonData(history);
    expect(changes.items[0]).toMatchObject({
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      applicationId: "test-app",
      delegationId: delegation.id,
    });

    state.scopes = ["resources:read"];
    const scopeDenied = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: {
        authorization: "Bearer lsp_agt_test_credential",
        "x-lifespace-delegation-id": delegation.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "scope denied", when: { kind: "date", start: "2026-10-06", endExclusive: "2026-10-07" } }),
    }, publicKey, identity);
    expect(scopeDenied.status).toBe(403);

    state.active = false;
    const revoked = await request(`/api/v1/spaces/${spaceId}/models/event/records/${created.id}`, {
      headers: { authorization: "Bearer lsp_agt_test_credential" },
    }, publicKey, identity);
    expect(revoked.status).toBe(401);
  });
});
