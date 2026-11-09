import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { oauthExecutionRouteAllowed, verifyAccessToken } from "../src/auth";

type TestEnv = { DB: D1Database };

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
  let active = true, checks = 0, lastBody: unknown;
  let delegationEnabled = false;
  let consentScopes = ["resources:read"];
  const bindings = {
    ENVIRONMENT: "staging", DB: db, IDENTITY_PUBLIC_KEY: publicKey,
    CORE_IDENTITY_SHARED_SECRET: "synthetic-core-to-identity-shared-secret",
    OAUTH_ACCOUNT_APPLICATION_ID: accountApp,
    IDENTITY: { fetch: async (url: string, init: RequestInit) => {
      checks++;
      const pathname = new URL(url).pathname;
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
    accountRequest, trustedRequest, oauthUser, accountApp, authId, client, resource,
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
    const projected=await f.request("GET",base+"/_discovery/operations",claims);
    expect(projected.status).toBe(200);
    const body=await projected.json() as {data:{operations:Array<{
      modelKey:string;operation:string;operationRef:string;inputSchema:{
        properties:Record<string,unknown>;$defs?:Record<string,unknown>;
      };
    }>}};
    const create=body.data.operations.find(o=>o.modelKey==="task"&&o.operation==="create");
    expect(create).toBeDefined();
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
