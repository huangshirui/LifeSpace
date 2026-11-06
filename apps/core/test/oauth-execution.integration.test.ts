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
  const client = "ocli_" + uuid;
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
  const bindings = {
    DB: db, IDENTITY_PUBLIC_KEY: publicKey,
    CORE_IDENTITY_SHARED_SECRET: "synthetic-core-to-identity-shared-secret",
    IDENTITY: { fetch: async (url: string, init: RequestInit) => {
      checks++;
      expect(new URL(url).pathname).toBe("/introspection/v1/oauth-executions");
      expect(new Headers(init.headers).get("x-lifespace-internal-secret"))
        .toBe("synthetic-core-to-identity-shared-secret");
      lastBody = JSON.parse(String(init.body));
      return Response.json({ data: { active } });
    } },
  };
  const jwt = (patch: Record<string, unknown> = {}) => sign({ ...claims, ...patch }, key, "RS256");
  const request = async (method: string, path: string, patch: Record<string, unknown> = {}, body?: unknown) => {
    const bearer = await jwt(patch);
    return createApp().request("http://localhost" + path, {
      method, headers: {
        authorization: "Bearer " + bearer,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, bindings);
  };
  return {
    agent, application, space, other, claims, jwt, request, publicKey, serverId,
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
    expect(oauthExecutionRouteAllowed("POST", "/api/v1/spaces/" + sp + "/models/task/records/query", sp)).toBe(true);
    for (const [method, path] of [
      ["GET", "/api/v1/me/spaces"],
      ["GET", "/api/v1/me/_discovery"],
      ["GET", "/api/v1/spaces/spc_other/_discovery/models/task"],
      ["POST", "/api/v1/spaces/spc_other/models/task/records/query"],
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
      { scope: "resources:read resources:write" },
      { scope: "resources:manage" },
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
  it("denies a disabled Core MCP Server even while OAuth is still active", async () => {
    const f = await fixture();
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory")).status).toBe(200);
    await f.setServerEnabled(false);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory")).status).toBe(403);
    expect((await f.request("GET", "/api/v1/spaces/" + f.space + "/_discovery/models/task")).status).toBe(403);
  });

  it("prunes Model Query after live MCP Server operation changes", async () => {
    const f = await fixture();
    const first = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(first.status).toBe(200);
    const models = (await first.json() as { data: { models: Array<{ key: string }> } }).data.models;
    expect(models.some(model => model.key === "task")).toBe(true);
    await f.setServerOperations(["get"]);
    const second = await f.request("GET", "/api/v1/me/_discovery/inventory");
    expect(second.status).toBe(200);
    const body = await second.json() as { data: { models: unknown[]; spaces: unknown[] } };
    expect(body.data.models).toEqual([]);
    expect(body.data.spaces).toEqual([]);
    expect((await f.request("GET", "/api/v1/spaces/" + f.space + "/_discovery/models/task")).status).toBe(403);
    expect((await f.request("POST", "/api/v1/spaces/" + f.space + "/models/task/records/query", {}, {})).status).toBe(403);
  });

  it("rejects unknown configured MCP Server and pre-v7 unscoped /mcp resources", async () => {
    const f = await fixture();
    const missing = "https://resource.example.test/mcp/mcp_" + "e".repeat(32);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory", { oauth_resource: missing })).status).toBe(403);
    expect((await f.request("GET", "/api/v1/me/_discovery/inventory", { oauth_resource: "https://resource.example.test/mcp" })).status).toBe(401);
  });

});
