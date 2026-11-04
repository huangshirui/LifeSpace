import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

type TestEnv = { DB: D1Database };
const app = createIdentityApp();

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return "-----BEGIN " + label + "-----\n"
    + (btoa(binary).match(/.{1,64}/g) || []).join("\n") + "\n-----END " + label + "-----";
}
async function setup() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const b = {
    DB: (env as unknown as TestEnv).DB,
    TOKEN_PRIVATE_KEY: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    TOKEN_PUBLIC_KEY: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
    BOOTSTRAP_SECRET: "oauth-test-bootstrap",
    CORE_IDENTITY_SHARED_SECRET: "oauth-test-internal-core-only",
    OAUTH_CORE_APPROVER_SECRET: "oauth-core-approver-only",
    OAUTH_RESOURCE_SERVER_SECRET: "oauth-test-resource-server-only",
    OAUTH_ISSUER: "https://auth.example.test",
    OAUTH_CONSENT_URL: "https://account.example.test/oauth/consent",
    OAUTH_ALLOWED_RESOURCES: "https://mcp.example.test/mcp/tasks https://mcp.example.test/mcp/health",
    ENVIRONMENT: "test",
    OAUTH_DCR_ENABLED: "1",
    OAUTH_ACCOUNT_APPLICATION_ID: "",
  };
  const request = (path: string, options: RequestInit = {}) => app.request("https://auth.example.test" + path, options, b);
  const bootstrap = async (scopes: string[]) => {
    const appId = "app_oauth_" + crypto.randomUUID().replaceAll("-", "");
    const res = await request("/bootstrap/v1/applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bootstrap-secret": b.BOOTSTRAP_SECRET },
      body: JSON.stringify({ id: appId, name: "OAuth Test", trustedBackend: true, allowedScopes: scopes }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { data: { clientSecret: string } };
    return { appId, secret: data.data.clientSecret };
  };
  const account = await bootstrap(["resources:read", "resources:write"]);
  b.OAUTH_ACCOUNT_APPLICATION_ID = account.appId;
  const target = await bootstrap(["resources:read", "resources:write"]);
  const userRes = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: "Bearer " + account.secret, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Account OAuth owner" }),
  });
  expect(userRes.status).toBe(201);
  const userId = (await userRes.json() as { data: { id: string } }).data.id;
  const userTokenRes = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: "Bearer " + account.secret, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: ["resources:read"] }),
  });
  expect(userTokenRes.status).toBe(200);
  const userToken = (await userTokenRes.json() as { data: { accessToken: string } }).data.accessToken;
  const agentRes = await request("/internal/v1/agents", {
    method: "POST",
    headers: { authorization: "Bearer " + target.secret, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "OAuth Agent" }),
  });
  expect(agentRes.status).toBe(201);
  const agentId = (await agentRes.json() as { data: { id: string } }).data.id;
  const registered = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      redirect_uris: ["https://client.example.test/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = (await registered.json() as { client_id: string }).client_id;
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const resource = "https://mcp.example.test/mcp/tasks";
  const redirect = "https://client.example.test/callback";
  const authorize = async (override: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect,
      resource, scope: "resources:read", state: "testState" + "x".repeat(36),
      code_challenge: challenge, code_challenge_method: "S256", ...override,
    });
    return request("/oauth/authorize?" + query.toString());
  };
  const approve = async (requestId: string, coreSecret: string | null, override: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (coreSecret) headers["x-lifespace-oauth-approver-secret"] = coreSecret;
    return request("/oauth/requests/" + requestId + "/approve", {
      method: "POST", headers,
      body: JSON.stringify({
        userToken, applicationId: target.appId,
        spaceId: "spc_oauth_test", agentId, allowUserAuthorization: true, ...override,
      }),
    });
  };
  const token = (body: Record<string, string>) => request("/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
  });
  const introspect = (opaque: string, requestedResource: string, secret = b.OAUTH_RESOURCE_SERVER_SECRET) =>
    request("/oauth/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-lifespace-resource-secret": secret },
      body: new URLSearchParams({ token: opaque, resource: requestedResource }),
    });
  const revoke = (opaque: string) => request("/oauth/revoke", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token: opaque }),
  });
  return { b, request, target, account, userId, agentId, clientId, verifier, redirect, resource, authorize, approve, token, introspect, revoke };
}

describe("Identity OAuth Authorization Server (isolated candidate)", () => {
  it("publishes fixed issuer metadata, protects DCR and rejects redirect/PKCE/resource substitution", async () => {
    const t = await setup();
    const metadata = await t.request("/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: t.b.OAUTH_ISSUER, code_challenge_methods_supported: ["S256"],
      token_endpoint: t.b.OAUTH_ISSUER + "/oauth/token",
    });
    const wrongRedirect = await t.authorize({ redirect_uri: "https://evil.example.test/callback" });
    expect(wrongRedirect.status).toBe(400);
    const weakPkce = await t.authorize({ code_challenge_method: "plain" });
    expect(weakPkce.status).toBe(400);
    const wrongResource = await t.authorize({ resource: "https://mcp.example.test/mcp/health/unpublished" });
    expect(wrongResource.status).toBe(400);
    const badRegistration = await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://*.example.test/cb"] }),
    });
    expect(badRegistration.status).toBe(400);
    t.b.ENVIRONMENT = "production";
    expect((await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [t.redirect] }),
    })).status).toBe(403);
  });

  it("requires trusted Core + Account-user proof before creating a one-time authorization; PKCE, resource and replay are enforced", async () => {
    const t = await setup();
    const pending = await t.authorize();
    expect(pending.status).toBe(302);
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    expect(requestId).toMatch(/^oar_/);
    expect((await t.approve(requestId, null)).status).toBe(401);
    expect((await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET, { agentId: "agt_unbound" })).status).toBe(403);
    const accepted = await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(accepted.status).toBe(200);
    const data = await accepted.json() as { redirect_url: string; authorization_id: string };
    const final = new URL(data.redirect_url);
    expect(final.origin + final.pathname).toBe(t.redirect);
    expect(final.searchParams.get("state")).toContain("testState");
    const code = final.searchParams.get("code")!;
    expect(code).toMatch(/^lsp_oac_/);
    expect((await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(400);
    const exchange = { grant_type: "authorization_code", code, client_id: t.clientId, redirect_uri: t.redirect, code_verifier: t.verifier, resource: t.resource };
    expect((await t.token({ ...exchange, code_verifier: "x".repeat(64) })).status).toBe(400);
    expect((await t.token({ ...exchange, resource: "https://mcp.example.test/mcp/health" })).status).toBe(400);
    const minted = await t.token(exchange);
    expect(minted.status).toBe(200);
    const tokens = await minted.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^lsp_oat_/);
    expect(tokens.refresh_token).toMatch(/^lsp_ort_/);
    expect((await t.token(exchange)).status).toBe(400);
    expect((await t.introspect(tokens.access_token, t.resource, "wrong")).status).toBe(401);
    expect(await (await t.introspect(tokens.access_token, "https://mcp.example.test/mcp/health")).json()).toEqual({ active: false });
    expect(await (await t.introspect(tokens.access_token, t.resource)).json()).toMatchObject({
      active: true, authorization_id: data.authorization_id, sub: t.userId,
      application_id: t.target.appId, space_id: "spc_oauth_test", agent_id: t.agentId,
      allow_user_authorization: true, resource: t.resource,
    });
    const refreshed = await t.token({ grant_type: "refresh_token", client_id: t.clientId, refresh_token: tokens.refresh_token, resource: t.resource });
    expect(refreshed.status).toBe(200);
    const refreshedToken = (await refreshed.json() as { access_token: string }).access_token;
    expect((await t.token({ grant_type: "refresh_token", client_id: t.clientId, refresh_token: tokens.refresh_token })).status).toBe(400);
    expect(await (await t.introspect(refreshedToken, t.resource)).json()).toEqual({ active: false });
  });

  it("revokes opaque access tokens immediately and fails closed when the bound Agent is disabled", async () => {
    const t = await setup();
    const pending = await t.authorize();
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const accepted = await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET);
    const code = new URL((await accepted.json() as { redirect_url: string }).redirect_url).searchParams.get("code")!;
    const minted = await t.token({ grant_type: "authorization_code", code, code_verifier: t.verifier, client_id: t.clientId, redirect_uri: t.redirect });
    const access = (await minted.json() as { access_token: string }).access_token;
    expect((await t.revoke(access)).status).toBe(200);
    expect(await (await t.introspect(access, t.resource)).json()).toEqual({ active: false });
    // Disabling the selected Agent denies even unexpired tokens, without requiring JWT expiry.
    await t.b.DB.prepare("UPDATE agents SET status='disabled' WHERE id=?").bind(t.agentId).run();
    expect(await (await t.introspect(access, t.resource)).json()).toEqual({ active: false });
  });
});
