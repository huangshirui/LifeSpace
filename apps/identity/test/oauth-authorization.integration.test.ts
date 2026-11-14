import { env } from "cloudflare:workers";
import { verify } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";
import { currentOAuthAccess } from "../src/oauth-authorization";

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
    OAUTH_DCR_RATE_LIMITER: { limit: async (_: { key: string }) => ({ success: true }) },
    OAUTH_AUTHORIZE_RATE_LIMITER: { limit: async (_: { key: string }) => ({ success: true }) },
    OAUTH_ACCOUNT_APPLICATION_ID: "",
  };
  // Isolated tests enable DCR explicitly. The default database policy remains
  // closed; any environment also requires an independent configured limiter.
  await b.DB.prepare(
    "UPDATE oauth_client_admission_policy SET dcr_enabled=1,cimd_enabled=0,"
    + "callback_mode='client',callback_uris_json='[]' WHERE id=1"
  ).run();
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
  const account = await bootstrap(["resources:read", "resources:write", "profile:read"]);
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
  return { b, request, target, account, userId, userToken, agentId, clientId, verifier, redirect, resource, authorize, approve, token, introspect, revoke };
}

describe("Identity OAuth Authorization Server (isolated candidate)", () => {
  it("lets only the verified Account owner list/revoke individual OAuth grants without disabling a shared Agent", async () => {
    const t=await setup();
    const ownerRes=await t.request("/internal/v1/tokens",{
      method:"POST",
      headers:{authorization:"Bearer "+t.account.secret,"content-type":"application/json"},
      body:JSON.stringify({subjectId:t.userId,scopes:["profile:read"]}),
    });
    expect(ownerRes.status).toBe(200);
    const ownerToken=(await ownerRes.json() as {data:{accessToken:string}}).data.accessToken;
    const headers={authorization:"Bearer "+ownerToken};
    const grant=async()=>{
      const pending=await t.authorize();
      expect(pending.status).toBe(302);
      const requestId=new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
      const result=await t.approve(requestId,t.b.OAUTH_CORE_APPROVER_SECRET);
      expect(result.status).toBe(200);
      return (await result.json() as {authorization_id:string;redirect_url:string});
    };
    const first=await grant(),second=await grant();
    const list=await t.request("/api/v1/me/oauth/authorizations?offset=0",{headers});
    expect(list.status).toBe(200);
    const records=(await list.json() as {data:{items:Array<{id:string;clientName:string;agentId:string;status:string;clientId:string}>;nextOffset:number|null}}).data;
    expect(new Set(records.items.map(i=>i.id))).toEqual(new Set([second.authorization_id,first.authorization_id]));
    expect(records.items.every(i=>i.agentId===t.agentId && i.status==="active")).toBe(true);
    expect(records.items[0].clientName).toBe("Test MCP Client");
    expect(records.nextOffset).toBeNull();
    expect(JSON.stringify(records)).not.toContain("lsp_ort_");
    const code=new URL(first.redirect_url).searchParams.get("code")!;
    const exchange=await t.token({grant_type:"authorization_code",client_id:t.clientId,code,
      redirect_uri:t.redirect,code_verifier:t.verifier});
    expect(exchange.status).toBe(200);
    const issued=(await exchange.json() as {access_token:string;refresh_token:string});
    const access=issued.access_token;
    const introspected=await t.introspect(access,t.resource);
    expect((await introspected.json() as {active:boolean}).active).toBe(true);
    expect((await t.request("/api/v1/me/oauth/authorizations",{headers:{authorization:"Bearer "+t.userToken}})).status).toBe(403);
    const outsiderRes=await t.request("/internal/v1/users",{
      method:"POST",headers:{authorization:"Bearer "+t.account.secret,"content-type":"application/json"},
      body:JSON.stringify({displayName:"Other Account user"}),
    });
    expect(outsiderRes.status).toBe(201);
    const otherId=(await outsiderRes.json() as {data:{id:string}}).data.id;
    const otherTokenRes=await t.request("/internal/v1/tokens",{
      method:"POST",headers:{authorization:"Bearer "+t.account.secret,"content-type":"application/json"},
      body:JSON.stringify({subjectId:otherId,scopes:["profile:read"]}),
    });
    const otherToken=(await otherTokenRes.json() as {data:{accessToken:string}}).data.accessToken;
    const otherHeaders={authorization:"Bearer "+otherToken};
    const otherList=await t.request("/api/v1/me/oauth/authorizations",{headers:otherHeaders});
    expect((await otherList.json() as {data:{items:unknown[]}}).data.items).toEqual([]);
    expect((await t.request("/api/v1/me/oauth/authorizations/"+first.authorization_id,{headers:otherHeaders})).status).toBe(404);
    expect((await t.request("/api/v1/me/oauth/authorizations/"+first.authorization_id+"/revoke",{
      method:"POST",headers:{...otherHeaders,"content-type":"application/json"},body:"{}",
    })).status).toBe(404);
    const revoked=await t.request("/api/v1/me/oauth/authorizations/"+first.authorization_id+"/revoke",{
      method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as {data:{id:string;revoked:boolean}}).data).toEqual({
      id:first.authorization_id,revoked:true,
    });
    expect((await t.request("/api/v1/me/oauth/authorizations/"+first.authorization_id+"/revoke",{
      method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}",
    })).status).toBe(409);
    const after=await t.request("/api/v1/me/oauth/authorizations",{headers});
    const statuses=(await after.json() as {data:{items:Array<{id:string;status:string}>}}).data.items;
    expect(statuses.find(row=>row.id===first.authorization_id)?.status).toBe("revoked");
    expect(statuses.find(row=>row.id===second.authorization_id)?.status).toBe("active");
    const denied=await t.introspect(access,t.resource);
    expect((await denied.json() as {active:boolean}).active).toBe(false);
    const refreshDenied=await t.token({grant_type:"refresh_token",client_id:t.clientId,
      refresh_token:issued.refresh_token});
    expect(refreshDenied.status).toBe(400);
    expect((await refreshDenied.json() as {error:string}).error).toBe("invalid_grant");
  });


  it("returns verified OAuth issuer to the client on Consent approval (RFC 9207)", async () => {
    const t = await setup();
    const pending = await t.authorize();
    expect(pending.status).toBe(302);
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const approved = await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(approved.status).toBe(200);
    const url = new URL((await approved.json() as { redirect_url: string }).redirect_url);
    expect(url.searchParams.get("iss")).toBe(t.b.OAUTH_ISSUER);
    expect(url.searchParams.get("code")?.startsWith("lsp_oac_")).toBe(true);
  });

  it("returns issuer-bound access_denied for user rejection without a grant or reusable pending request", async () => {
    const t = await setup();
    const pending = await t.authorize();
    expect(pending.status).toBe(302);
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const deny = (secret: string | null, userToken = t.userToken) => t.request(
      "/oauth/requests/" + requestId + "/deny", {
        method: "POST",
        headers: { "content-type": "application/json",
          ...(secret ? { "x-lifespace-oauth-approver-secret": secret } : {}) },
        body: JSON.stringify({ userToken }),
      });
    expect((await deny(null)).status).toBe(401);
    expect((await deny(t.b.OAUTH_CORE_APPROVER_SECRET, "forged-user-token")).status).toBe(401);
    const response = await deny(t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(response.status).toBe(200);
    const url = new URL((await response.json() as { redirect_url: string }).redirect_url);
    expect(url.origin).toBe(new URL(t.redirect).origin);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("iss")).toBe(t.b.OAUTH_ISSUER);
    expect(url.searchParams.get("state")).toBe("testState" + "x".repeat(36));
    expect(url.searchParams.has("code")).toBe(false);
    expect((await deny(t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(400);
    expect((await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(400);
  });

  it("checks Core Server state at dynamic OAuth request and again at Consent approval", async () => {
    const t = await setup();
    const id = "mcp_" + crypto.randomUUID().replaceAll("-", "");
    const resource = "https://core.example.test/mcp/" + id;
    (t.b as typeof t.b & { OAUTH_MCP_RESOURCE_ORIGIN: string }).OAUTH_MCP_RESOURCE_ORIGIN =
      "https://core.example.test";
    let active = false;
    let offeredScopes = ["resources:read"];
    let validations = 0;
    (t.b as typeof t.b & { CORE: { fetch: (url: string, init: RequestInit) => Promise<Response> } }).CORE = {
      fetch: async (url: string, init: RequestInit) => {
        validations++;
        expect(new URL(url).pathname).toBe("/internal/v1/oauth/mcp-resource/validate");
        expect(new Headers(init.headers).get("x-lifespace-internal-secret"))
          .toBe(t.b.CORE_IDENTITY_SHARED_SECRET);
        expect(JSON.parse(String(init.body))).toEqual({ resource });
        return Response.json({ data: { active, ...(active ? { resource, scopes: offeredScopes } : {}) } });
      },
    };
    expect((await t.authorize({ resource })).status).toBe(400);
    active = true;
    // A client cannot manufacture write consent for a read-only MCP Server.
    expect((await t.authorize({ resource, scope: "resources:read resources:write" })).status).toBe(400);
    offeredScopes = ["resources:read", "resources:write"];
    const pending = await t.authorize({ resource, scope: "resources:read resources:write" });
    expect(pending.status).toBe(302);
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    active = false;
    expect((await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(403);
    expect(validations).toBe(4);
  });


  it("uses current Console policy as the sole CIMD/DCR switch without deployment variables", async () => {
    const t = await setup();
    const defaultMetadata = await t.request("/.well-known/oauth-authorization-server");
    expect(defaultMetadata.status).toBe(200);
    expect(await defaultMetadata.json()).not.toHaveProperty("client_id_metadata_document_supported");
    const initial = await t.request("/.well-known/oauth-authorization-server");
    expect(await initial.json()).toHaveProperty("registration_endpoint");
    await t.b.DB.prepare(
      "UPDATE oauth_client_admission_policy SET cimd_enabled=1 WHERE id=1"
    ).run();
    const optInMetadata = await t.request("/.well-known/oauth-authorization-server");
    expect(optInMetadata.status).toBe(200);
    expect(await optInMetadata.json()).toMatchObject({
      client_id_metadata_document_supported: true,
      registration_endpoint: t.b.OAUTH_ISSUER + "/oauth/register",
    });
    // Missing authorization limiter still fails closed for CIMD, not DCR.
    const limiter = t.b.OAUTH_AUTHORIZE_RATE_LIMITER;
    Reflect.deleteProperty(t.b, "OAUTH_AUTHORIZE_RATE_LIMITER");
    const noAuthorizeLimiter = await t.request("/.well-known/oauth-authorization-server");
    expect(await noAuthorizeLimiter.json()).not.toHaveProperty("client_id_metadata_document_supported");
    t.b.OAUTH_AUTHORIZE_RATE_LIMITER = limiter;
    await t.b.DB.prepare("UPDATE oauth_client_admission_policy SET cimd_enabled=0,dcr_enabled=0 WHERE id=1").run();
    const disabled = await (await t.request("/.well-known/oauth-authorization-server")).json();
    expect(disabled).not.toHaveProperty("client_id_metadata_document_supported");
    expect(disabled).not.toHaveProperty("registration_endpoint");
    expect((await t.request("/oauth/register", {method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({redirect_uris:[t.redirect]})})).status).toBe(403);
    expect((await t.authorize({client_id:"https://public-client.example.com/client.json"})).status).toBe(400);
  });

  it("publishes fixed issuer metadata, protects DCR and rejects redirect/PKCE/resource substitution", async () => {
    const t = await setup();
    const metadata = await t.request("/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: t.b.OAUTH_ISSUER, authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
      token_endpoint: t.b.OAUTH_ISSUER + "/oauth/token",
    });
    const wrongRedirect = await t.authorize({ redirect_uri: "https://evil.example.test/callback" });
    expect(wrongRedirect.status).toBe(400);
    const weakPkce = await t.authorize({ code_challenge_method: "plain" });
    expect(weakPkce.status).toBe(400);
    const wrongResource = await t.authorize({ resource: "https://mcp.example.test/mcp/health/unpublished" });
    expect(wrongResource.status).toBe(400);
    expect((await t.authorize({ scope: "resources:manage" })).status).toBe(400);
    expect((await t.authorize({ scope: "resources:read unsupported:scope" })).status).toBe(400);
    const badRegistration = await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://*.example.test/cb"] }),
    });
    expect(badRegistration.status).toBe(400);
    t.b.ENVIRONMENT = "production";
    expect((await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [t.redirect] }),
    })).status).toBe(201);
  });

  it("fails closed without a DCR limiter, rejects exhausted budget, and supports guarded Production", async () => {
    const t = await setup();
    const b = t.b as typeof t.b & {
      OAUTH_DCR_RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
    };
    b.ENVIRONMENT = "staging";
    Reflect.deleteProperty(b, "OAUTH_DCR_RATE_LIMITER");
    const before = await t.request("/.well-known/oauth-authorization-server");
    expect(await before.json()).not.toHaveProperty("registration_endpoint");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [t.redirect], token_endpoint_auth_method: "none" }),
    };
    expect((await t.request("/oauth/register", options)).status).toBe(403);
    const keys: string[] = [];
    b.OAUTH_DCR_RATE_LIMITER = {
      limit: async ({ key }) => { keys.push(key); return { success: false }; },
    };
    const configured = await t.request("/.well-known/oauth-authorization-server");
    expect(await configured.json()).toHaveProperty("registration_endpoint", t.b.OAUTH_ISSUER + "/oauth/register");
    expect((await t.request("/oauth/register", options)).status).toBe(429);
    expect(keys).toEqual(["oauth-dcr-global"]);
    b.OAUTH_DCR_RATE_LIMITER = {
      limit: async () => ({ success: true }),
    };
    expect((await t.request("/oauth/register", {
      ...options, headers: { "content-type": "text/plain" },
    })).status).toBe(400);
    const denied = await t.request("/oauth/register", {
      ...options, body: JSON.stringify({ redirect_uris: ["https://*.example.com/cb"] }),
    });
    expect(denied.status).toBe(400);
    const oversized = await t.request("/oauth/register", {
      ...options, body: JSON.stringify({ redirect_uris: [t.redirect], unused: "x".repeat(9000) }),
    });
    expect(oversized.status).toBe(400);
    const accepted = await t.request("/oauth/register", options);
    expect(accepted.status).toBe(201);
    expect((await accepted.json() as { client_id: string }).client_id.startsWith("ocli_")).toBe(true);
    b.ENVIRONMENT = "production";
    const available = await t.request("/.well-known/oauth-authorization-server");
    expect(await available.json()).toHaveProperty("registration_endpoint");
    expect((await t.request("/oauth/register", options)).status).toBe(201);
    // Operator disabling the policy must take effect immediately.
    await t.b.DB.prepare("UPDATE oauth_client_admission_policy SET dcr_enabled=0 WHERE id=1").run();
    expect((await t.request("/oauth/register", options)).status).toBe(403);
  });

  it("admits a new DCR client without a platform callback entry while still enforcing its registered callback", async () => {
    const t = await setup();
    const env = t.b as typeof t.b & { OAUTH_DCR_RATE_LIMITER: { limit: () => Promise<{ success: boolean }> } };
    env.ENVIRONMENT = "staging";
    env.OAUTH_DCR_RATE_LIMITER = { limit: async () => ({ success: true }) };
    await t.b.DB.prepare(
      "UPDATE oauth_client_admission_policy SET dcr_enabled=1,callback_mode='client',callback_uris_json='[]' WHERE id=1"
    ).run();
    const metadata = await t.request("/.well-known/oauth-authorization-server");
    expect(await metadata.json()).toHaveProperty("registration_endpoint", t.b.OAUTH_ISSUER + "/oauth/register");
    const redirect = "https://new-client.example.com/callback";
    const registered = await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    expect(registered.status).toBe(201);
    const clientId = (await registered.json() as { client_id: string }).client_id;
    expect((await t.authorize({ client_id: clientId, redirect_uri: redirect })).status).toBe(302);
    expect((await t.authorize({ client_id: clientId, redirect_uri: "https://other-client.example.com/callback" })).status).toBe(400);
    // The extra global callback setting is optional, but must constrain
    // existing registrations too when an administrator enables it.
    await t.b.DB.prepare(
      "UPDATE oauth_client_admission_policy SET callback_mode='restricted',callback_uris_json=? WHERE id=1"
    ).bind(JSON.stringify([t.redirect])).run();
    expect((await t.authorize({ client_id: clientId, redirect_uri: redirect })).status).toBe(400);
    expect((await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect] }),
    })).status).toBe(403);
  });

  it("admits a CIMD client with an unlisted HTTPS Client ID only in guarded open mode", async () => {
    const t = await setup();
    const b = t.b as typeof t.b & {
      OAUTH_DCR_RATE_LIMITER: { limit: ({ key }: { key: string }) => Promise<{ success: boolean }> };
    };
    b.ENVIRONMENT = "staging";
    const remoteId = "https://public-client.example.com/oauth/client.json";
    const redirect = "https://client.example.test/callback";
    await b.DB.prepare(
      "UPDATE oauth_client_admission_policy SET cimd_enabled=1 WHERE id=1"
    ).run();
    Reflect.deleteProperty(b, "OAUTH_DCR_RATE_LIMITER");
    const withoutLimiter = await t.request("/.well-known/oauth-authorization-server");
    expect(await withoutLimiter.json()).not.toHaveProperty("client_id_metadata_document_supported");
    expect((await t.authorize({ client_id: remoteId, redirect_uri: redirect })).status).toBe(400);
    b.OAUTH_DCR_RATE_LIMITER = { limit: async () => ({ success: true }) };
    const keys: string[] = [];
    b.OAUTH_DCR_RATE_LIMITER = { limit: async ({ key }) => {
      keys.push(key);
      return { success: true };
    } };
    const oldFetch = globalThis.fetch;
    let documentCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (typeof input === "string" && input.startsWith("https://cloudflare-dns.com/dns-query?")) {
        return Response.json({Status:0,Answer:input.endsWith("type=1")?[{type:1,data:"8.8.8.8"}]:[]});
      }
      if (input !== remoteId) throw new Error("Unexpected metadata fetch");
      documentCalls++;
      return Response.json({
        client_id: remoteId, client_name: "Unverified Public Agent",
        redirect_uris: [redirect],
        response_types: ["code"], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
      });
    }) as typeof fetch;
    try {
      const accepted = await t.authorize({ client_id: remoteId, redirect_uri: redirect });
      expect(accepted.status).toBe(302);
      expect(documentCalls).toBe(1);
      expect(keys).toEqual(["oauth-cimd-fetch"]);
      const unsupportedGrant = await t.token({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        client_id: remoteId, assertion: "not-a-jwt",
      });
      expect(unsupportedGrant.status).toBe(400);
      expect(await unsupportedGrant.json()).toMatchObject({ error: "unsupported_grant_type" });
      expect((await t.authorize({ client_id: remoteId,
        redirect_uri: "https://other-client.example.com/callback" })).status).toBe(400);
      const callsBeforeDisable = documentCalls;
      await b.DB.prepare("UPDATE oauth_client_admission_policy SET cimd_enabled=0 WHERE id=1").run();
      expect((await t.authorize({ client_id: remoteId, redirect_uri: redirect })).status).toBe(400);
      expect(documentCalls).toBe(callsBeforeDisable);
      expect(await (await t.request("/.well-known/oauth-authorization-server")).json())
        .not.toHaveProperty("client_id_metadata_document_supported");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("revalidates live CIMD on consent and retries only transient failures within the same rate limit", async () => {
    const t = await setup();
    await t.b.DB.prepare("UPDATE oauth_client_admission_policy SET cimd_enabled=1 WHERE id=1").run();
    const clientId = "https://public-client.example.com/oauth/client.json";
    const redirect = "https://client.example.test/callback";
    const originalFetch = globalThis.fetch;
    let documentCalls = 0;
    let dnsCalls = 0;
    let limiterCalls = 0;
    let remaining = 100;
    let failures: number[] = [];
    let advertised = redirect;
    let denyDns = false;
    t.b.OAUTH_DCR_RATE_LIMITER = { limit: async ({key}) => {
      expect(key).toBe("oauth-cimd-fetch");
      limiterCalls++;
      return {success: remaining-- > 0};
    }};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (typeof input === "string" && input.startsWith("https://cloudflare-dns.com/dns-query?")) {
        dnsCalls++;
        return Response.json({Status:0,Answer:input.endsWith("type=1")?
          [{type:1,data:denyDns?"127.0.0.1":"8.8.8.8"}]:[]});
      }
      expect(input).toBe(clientId);
      documentCalls++;
      const status = failures.shift();
      if (status) return new Response(null,{status});
      return Response.json({client_id:clientId,client_name:"Public test agent",
        redirect_uris:[advertised], response_types:["code"], token_endpoint_auth_method:"none",
        grant_types:["authorization_code","refresh_token"]});
    }) as typeof fetch;
    try {
      const pending = async () => {
        const response = await t.authorize({client_id:clientId,redirect_uri:redirect});
        expect(response.status).toBe(302);
        return new URL(response.headers.get("location")!).searchParams.get("request_id")!;
      };
      const id = await pending();
      // Fresh metadata is required at consent; temporary upstream 503 is
      // retried only with another admission and a new A/AAAA check.
      failures = [503];
      const before = {documentCalls,dnsCalls,limiterCalls};
      expect((await t.approve(id,t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(200);
      expect(documentCalls-before.documentCalls).toBe(2);
      expect(dnsCalls-before.dnsCalls).toBe(4);
      expect(limiterCalls-before.limiterCalls).toBe(2);
      // A permanent denial must not use cached metadata or retry.
      const deniedId = await pending();
      failures = [403];
      const deniedBefore = documentCalls;
      expect((await t.approve(deniedId,t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(403);
      expect(documentCalls-deniedBefore).toBe(1);
      // A transient failure cannot bypass the existing limiter.
      remaining = 1;
      failures = [503];
      const limitedBefore = documentCalls;
      expect((await t.approve(deniedId,t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(403);
      expect(documentCalls-limitedBefore).toBe(1);
      remaining = 100;
      // Rebinding to a private address is rejected without an HTTPS fetch.
      denyDns = true;
      const privateBefore = documentCalls;
      const privateLimitBefore = limiterCalls;
      expect((await t.approve(deniedId,t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(403);
      expect(documentCalls).toBe(privateBefore);
      expect(limiterCalls-privateLimitBefore).toBe(1);
      denyDns = false;
      // Even a valid current document may not change a registered callback.
      advertised = "https://different.example.test/callback";
      expect((await t.approve(deniedId,t.b.OAUTH_CORE_APPROVER_SECRET)).status).toBe(403);
      const row = await t.b.DB.prepare("SELECT status FROM oauth_authorization_requests WHERE id=?").bind(deniedId).first<{status:string}>();
      expect(row?.status).toBe("pending");
      expect(await t.b.DB.prepare("SELECT id FROM oauth_authorizations WHERE request_id=?").bind(deniedId).first()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rate-limits authorization and bounds live pending writes across regions", async () => {
    const t = await setup();
    const b = t.b as typeof t.b & {
      OAUTH_AUTHORIZE_RATE_LIMITER?: { limit: () => Promise<{ success: boolean }> };
    };
    Reflect.deleteProperty(b, "OAUTH_AUTHORIZE_RATE_LIMITER");
    expect((await t.authorize()).status).toBe(503);
    b.OAUTH_AUTHORIZE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await t.authorize()).status).toBe(429);
    b.OAUTH_AUTHORIZE_RATE_LIMITER = { limit: async () => ({ success: true }) };

    // The shared worker test DB may contain legitimate pending fixtures from
    // earlier tests. Fill only the remaining capacity, then delete OUR rows.
    const oldRequest = "oar_expired_unbound_test";
    const now = new Date().toISOString();
    await b.DB.prepare(
      "INSERT INTO oauth_authorization_requests"
      + "(id,client_id,redirect_uri,state,resource,scopes,code_challenge,status,expires_at,created_at)"
      + " VALUES(?,?,?,?,?,?,?,'pending',?,?)"
    ).bind(oldRequest, t.clientId, t.redirect, "testState" + "x".repeat(36),
      t.resource, JSON.stringify(["resources:read"]), "a".repeat(43),
      new Date(Date.now() - 2 * 3600000).toISOString(), now).run();
    const accepted = await t.authorize();
    expect(accepted.status).toBe(302);
    const ownRequestId = new URL(accepted.headers.get("location")!).searchParams.get("request_id")!;
    try {
      expect(await b.DB.prepare("SELECT id FROM oauth_authorization_requests WHERE id=?")
        .bind(oldRequest).first()).toBeNull();
      const liveBefore = await b.DB.prepare(
        "SELECT count(*) as n FROM oauth_authorization_requests WHERE status='pending' AND expires_at>?"
      ).bind(now).first<{ n: number }>();
      const remaining = 1000 - (liveBefore?.n ?? 0);
      expect(remaining).toBeGreaterThan(0);
      const expires = new Date(Date.now() + 600000).toISOString();
      await b.DB.prepare(
        "WITH RECURSIVE seq(n) AS (SELECT 1 WHERE ?>0 "
        + "UNION ALL SELECT n+1 FROM seq WHERE n+1<=?) "
        + "INSERT INTO oauth_authorization_requests"
        + "(id,client_id,redirect_uri,state,resource,scopes,code_challenge,status,expires_at,created_at)"
        + " SELECT 'oar_quota_'||n,?,?,?,?,?,?,'pending',?,? FROM seq"
      ).bind(remaining, remaining, t.clientId, t.redirect, "testState" + "x".repeat(36),
        t.resource, JSON.stringify(["resources:read"]), "a".repeat(43), expires, now).run();
      expect((await t.authorize()).status).toBe(429);
      const count = await b.DB.prepare(
        "SELECT count(*) as n FROM oauth_authorization_requests WHERE status='pending' AND expires_at>?"
      ).bind(now).first<{ n: number }>();
      expect(count?.n).toBe(1000);
    } finally {
      // Vitest's shared D1 fixture persists between tests in this file.
      await b.DB.prepare("DELETE FROM oauth_authorization_requests WHERE id GLOB 'oar_quota_*'").run();
      await b.DB.prepare("DELETE FROM oauth_authorization_requests WHERE id=?")
        .bind(ownRequestId).run();
    }
  });

  it("reclaims only expired and never-used anonymous DCR clients", async () => {
    const t = await setup();
    const b = t.b;
    const old = "ocli_unused_" + crypto.randomUUID().replaceAll("-", "");
    const retained = "ocli_active_" + crypto.randomUUID().replaceAll("-", "");
    const oldCreated = new Date(Date.now() - 8 * 86400000).toISOString();
    const redirectJson = JSON.stringify([t.redirect]);
    for (const clientId of [old, retained]) {
      await b.DB.prepare(
        "INSERT INTO oauth_clients(id,display_name,redirect_uris,status,created_at)"
        + " VALUES(?,?,?,'active',?)"
      ).bind(clientId, "Synthetic older client", redirectJson, oldCreated).run();
    }
    await b.DB.prepare(
      "INSERT INTO oauth_authorization_requests"
      + "(id,client_id,redirect_uri,state,resource,scopes,code_challenge,status,expires_at,created_at)"
      + " VALUES(?,?,?,?,?,?,?,'pending',?,?)"
    ).bind("oar_retain_active_client", retained, t.redirect, "testState" + "x".repeat(36),
      t.resource, JSON.stringify(["resources:read"]), "a".repeat(43),
      new Date(Date.now() + 600000).toISOString(), new Date().toISOString()).run();
    const res = await t.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://another-client.example.com/callback"] }),
    });
    expect(res.status).toBe(201);
    expect(await b.DB.prepare("SELECT id FROM oauth_clients WHERE id=?").bind(old).first()).toBeNull();
    expect(await b.DB.prepare("SELECT id FROM oauth_clients WHERE id=?").bind(retained).first()).not.toBeNull();
  });

  it("requires private Core authentication and bounded Agent IDs for active binding resolution", async () => {
    const t = await setup();
    const url = "/oauth/core/agent-candidates";
    const post = (secret: string | null, agentIds: string[]) => t.request(url, {
      method: "POST", headers: {
        "content-type": "application/json",
        ...(secret ? { "x-lifespace-internal-secret": secret } : {}),
      },
      body: JSON.stringify({ agentIds }),
    });
    expect((await post(null, [t.agentId])).status).toBe(401);
    expect((await post(t.b.OAUTH_CORE_APPROVER_SECRET, [t.agentId])).status).toBe(401);
    expect((await post(t.b.CORE_IDENTITY_SHARED_SECRET, [])).status).toBe(400);
    const resolved = await post(t.b.CORE_IDENTITY_SHARED_SECRET, [t.agentId]);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ data: [
      { agentId: t.agentId, applicationId: t.target.appId },
    ] });
  });

  it("returns only pending client metadata to authenticated Account, never scope authority or unverified vendor identity", async () => {
    const t = await setup();
    const pending = await t.authorize();
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const path = "/api/v1/me/oauth/requests/" + requestId;
    expect((await t.request(path)).status).toBe(401);
    const preview = await t.request(path, {
      headers: { authorization: "Bearer " + t.userToken },
    });
    expect(preview.status).toBe(200);
    const data = (await preview.json() as any).data;
    expect(data).toMatchObject({
      id: requestId,
      client: { id: t.clientId, name: "Test MCP Client", verifiedVendor: false,
        redirectOrigin: "https://client.example.test" },
      resource: t.resource,
      status: "pending", requestedScopes: ["resources:read"],
    });
    expect(JSON.stringify(data)).not.toContain("userToken");
    expect(data).not.toHaveProperty("spaceId");
    expect(data).not.toHaveProperty("agentId");
    expect(data).not.toHaveProperty("currentGrants");
    const otherUserToken = await t.request("/internal/v1/tokens", {
      method: "POST",
      headers: { authorization: "Bearer " + t.target.secret, "content-type": "application/json" },
      body: JSON.stringify({ subjectId: t.userId, scopes: ["resources:read"] }),
    });
    expect(otherUserToken.status).toBe(200);
    const alien = (await otherUserToken.json() as any).data.accessToken;
    expect((await t.request(path, {
      headers: { authorization: "Bearer " + alien },
    })).status).toBe(403);
  });

  it("requires trusted Core + Account-user proof before creating a one-time authorization; PKCE, resource and replay are enforced", async () => {
    const t = await setup();
    const pending = await t.authorize();
    expect(pending.status).toBe(302);
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    expect(requestId).toMatch(/^oar_/);
    expect((await t.approve(requestId, null)).status).toBe(401);
    expect((await t.approve(requestId, t.b.CORE_IDENTITY_SHARED_SECRET)).status).toBe(401);
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
  it("privately mints bounded Agent Direct Core JWT only from a live exact-resource OAuth bearer", async () => {
    const t = await setup();
    const pending = await t.authorize();
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const approved = await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(approved.status).toBe(200);
    const code = new URL((await approved.json() as { redirect_url: string }).redirect_url).searchParams.get("code")!;
    const issued = await t.token({
      grant_type: "authorization_code", client_id: t.clientId,
      redirect_uri: t.redirect, code, code_verifier: t.verifier, resource: t.resource,
    });
    expect(issued.status).toBe(200);
    const oauthBearer = (await issued.json() as { access_token: string }).access_token;
    const exchange = (secret: string | null, token: string, resource: string, includeContext?: boolean) => t.request("/oauth/execution-tokens", {
      method: "POST",
      headers: { "content-type": "application/json",
        ...(secret ? { "x-lifespace-resource-secret": secret } : {}) },
      body: JSON.stringify({ token, resource, ...(includeContext === undefined ? {} : {includeContext}) }),
    });
    expect((await exchange(null, oauthBearer, t.resource)).status).toBe(401);
    expect((await exchange(t.b.CORE_IDENTITY_SHARED_SECRET, oauthBearer, t.resource)).status).toBe(401);
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, "https://mcp.example.test/mcp/health")).status).toBe(401);
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, "lsp_oat_" + "z".repeat(43), t.resource)).status).toBe(401);
    const issuedCore = await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, t.resource);
    expect(issuedCore.status).toBe(200);
    const data = (await issuedCore.json() as { data: {
      accessToken: string; scope: string; expiresIn: number; applicationId: string; agentId: string; spaceId: string;
    } }).data;
    expect(data).toMatchObject({ scope: "resources:read", agentId: t.agentId, applicationId: t.target.appId, spaceId: "spc_oauth_test" });
    expect(data.expiresIn).toBeGreaterThan(0);
    expect(data.expiresIn).toBeLessThanOrEqual(60);
    expect(data).not.toHaveProperty("context");
    const combined = await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, t.resource, true);
    expect(combined.status).toBe(200);
    expect(combined.headers.get("cache-control")).toBe("no-store");
    const combinedData = (await combined.json() as {data:{accessToken:string;scope:string;context:Record<string,unknown>}}).data;
    const combinedClaims = await verify(combinedData.accessToken, t.b.TOKEN_PUBLIC_KEY, "RS256");
    expect(combinedData.context).toMatchObject({active:true, client_id:t.clientId,
      authorization_id:combinedClaims.oauth_authorization_id, sub:t.userId,
      application_id:t.target.appId, space_id:"spc_oauth_test", agent_id:t.agentId,
      allow_user_authorization:true, resource:t.resource, scope:combinedData.scope});
    expect(Number(combinedData.context.exp)).toBeGreaterThanOrEqual(Number(combinedClaims.exp));
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, t.resource, false)).status).toBe(400);
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, "https://mcp.example.test/mcp/health", true)).status).toBe(401);
    const claims = await verify(data.accessToken, t.b.TOKEN_PUBLIC_KEY, "RS256");
    expect(claims).toMatchObject({
      iss: "lifespace-identity", aud: "lifespace-core",
      sub: t.agentId, azp: t.target.appId,
      principal_type: "agent", principal_id: t.agentId,
      actor_type: "agent", actor_id: t.agentId,
      purpose: "oauth_agent_execution", scope: "resources:read",
      oauth_space_id: "spc_oauth_test", oauth_resource: t.resource, oauth_client_id: t.clientId,
    });
    expect(claims).not.toHaveProperty("delegation_id");
    expect(claims).not.toHaveProperty("principal_user_id");
    const check = (context: Record<string, unknown>, secret: string | null) => t.request("/introspection/v1/oauth-executions", {
      method: "POST", headers: { "content-type": "application/json",
        ...(secret ? { "x-lifespace-internal-secret": secret } : {}) },
      body: JSON.stringify(context),
    });
    const context = {
      authorizationId: claims.oauth_authorization_id, tokenHash: claims.oauth_access_hash,
      clientId: t.clientId, resource: t.resource,
      applicationId: t.target.appId, agentId: t.agentId, spaceId: "spc_oauth_test",
    };
    expect((await check(context, null)).status).toBe(401);
    expect((await check(context, t.b.OAUTH_RESOURCE_SERVER_SECRET)).status).toBe(401);
    expect(await (await check(context, t.b.CORE_IDENTITY_SHARED_SECRET)).json()).toEqual({ data: { active: true, scopes: ["resources:read"], userId: t.userId, allowUserAuthorization: true } });
    expect(await (await check({ ...context, spaceId: "spc_wrong" }, t.b.CORE_IDENTITY_SHARED_SECRET)).json()).toEqual({ data: { active: false } });
    expect(await (await check({ ...context, agentId: "agt_wrong" }, t.b.CORE_IDENTITY_SHARED_SECRET)).json()).toEqual({ data: { active: false } });
    expect((await t.revoke(oauthBearer)).status).toBe(200);
    expect(await (await check(context, t.b.CORE_IDENTITY_SHARED_SECRET)).json()).toEqual({ data: { active: false } });
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, t.resource)).status).toBe(401);
    expect((await exchange(t.b.OAUTH_RESOURCE_SERVER_SECRET, oauthBearer, t.resource, true)).status).toBe(401);
  });

  it("reads each current OAuth access snapshot with one D1 statement and fails closed on live changes", async () => {
    const t = await setup();
    const pending = await t.authorize();
    const requestId = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const approved = await t.approve(requestId, t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(approved.status).toBe(200);
    const code = new URL((await approved.json() as {redirect_url:string}).redirect_url).searchParams.get("code")!;
    const issued = await t.token({grant_type:"authorization_code",client_id:t.clientId,
      redirect_uri:t.redirect,code,code_verifier:t.verifier,resource:t.resource});
    expect(issued.status).toBe(200);
    const bearer=(await issued.json() as {access_token:string}).access_token;
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(bearer))),
      b=>b.toString(16).padStart(2,"0")).join("");
    const queries:string[]=[];
    const db=new Proxy(t.b.DB,{
      get(target,key){
        if(key==="prepare")return (sql:string)=>{queries.push(sql);return target.prepare(sql);};
        const value=Reflect.get(target,key,target);
        return typeof value==="function"?value.bind(target):value;
      },
    });
    const snapshot=await currentOAuthAccess(db,digest,t.resource);
    expect(snapshot?.selected).toMatchObject({agent_id:t.agentId,application_id:t.target.appId,client_id:t.clientId});
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("JOIN oauth_access_tokens");
    expect(await currentOAuthAccess(db,digest,"https://mcp.example.test/mcp/health")).toBeNull();
    expect(await currentOAuthAccess(db,"f".repeat(64),t.resource)).toBeNull();

    const check=async()=>{
      expect(await currentOAuthAccess(db,digest,t.resource)).toBeNull();
      expect(await (await t.introspect(bearer,t.resource)).json()).toEqual({active:false});
      const exchange=await t.request("/oauth/execution-tokens",{method:"POST",
        headers:{"content-type":"application/json","x-lifespace-resource-secret":t.b.OAUTH_RESOURCE_SERVER_SECRET},
        body:JSON.stringify({token:bearer,resource:t.resource})});
      expect(exchange.status).toBe(401);
    };
    // Each transition is visible immediately; no positive cache from the
    // earlier successful snapshot. Restore only synthetic fixture rows.
    await t.b.DB.prepare("UPDATE oauth_clients SET status='disabled' WHERE id=?").bind(t.clientId).run();
    await check();
    await t.b.DB.prepare("UPDATE oauth_clients SET status='active' WHERE id=?").bind(t.clientId).run();
    await t.b.DB.prepare("UPDATE agents SET status='disabled' WHERE id=?").bind(t.agentId).run();
    await check();
    await t.b.DB.prepare("UPDATE agents SET status='active' WHERE id=?").bind(t.agentId).run();
    await t.b.DB.prepare("UPDATE applications SET allowed_scopes='[]' WHERE id=?").bind(t.target.appId).run();
    await check();
    await t.b.DB.prepare("UPDATE applications SET allowed_scopes=? WHERE id=?").bind(JSON.stringify(["resources:read","resources:write"]),t.target.appId).run();
    expect(await currentOAuthAccess(db,digest,t.resource)).not.toBeNull();
    await t.b.DB.prepare("UPDATE oauth_access_tokens SET expires_at=? WHERE token_hash=?").bind("2000-01-01T00:00:00Z",digest).run();
    await check();
  });

  it("preserves explicit read/write consent across environments and rechecks live Scope", async () => {
    const t = await setup();
    const pending = await t.authorize({ scope: "resources:read resources:write" });
    const id = new URL(pending.headers.get("location")!).searchParams.get("request_id")!;
    const approved = await t.approve(id, t.b.OAUTH_CORE_APPROVER_SECRET);
    expect(approved.status).toBe(200);
    const code = new URL((await approved.json() as { redirect_url: string }).redirect_url).searchParams.get("code")!;
    const issued = await t.token({ grant_type: "authorization_code", client_id: t.clientId,
      code, code_verifier: t.verifier, redirect_uri: t.redirect, resource: t.resource });
    const bearer = (await issued.json() as { access_token: string }).access_token;
    const exchange = (includeContext = false) => t.request("/oauth/execution-tokens", {
      method: "POST", headers: { "content-type": "application/json", "x-lifespace-resource-secret": t.b.OAUTH_RESOURCE_SERVER_SECRET },
      body: JSON.stringify({ token: bearer, resource: t.resource, ...(includeContext ? {includeContext:true} : {}) }),
    });
    t.b.ENVIRONMENT = "staging";
    const data = (await (await exchange()).json() as { data: { scope: string; accessToken: string } }).data;
    expect(data.scope).toBe("resources:read resources:write");
    expect((await verify(data.accessToken, t.b.TOKEN_PUBLIC_KEY, "RS256")).principal_type).toBe("agent");
    t.b.ENVIRONMENT = "production";
    expect((await (await exchange()).json() as { data: { scope: string } }).data.scope).toBe("resources:read resources:write");
    t.b.ENVIRONMENT = "staging";
    await t.b.DB.prepare("UPDATE oauth_authorizations SET scopes=? WHERE client_id=?")
      .bind(JSON.stringify(["resources:read"]), t.clientId).run();
    expect((await (await exchange()).json() as { data: { scope: string } }).data.scope).toBe("resources:read");
    const narrowed=(await (await exchange(true)).json() as {data:{scope:string;context:{scope:string}}}).data;
    expect(narrowed.scope).toBe("resources:read");
    expect(narrowed.context.scope).toBe("resources:read");
    await t.b.DB.prepare("UPDATE oauth_authorizations SET scopes=? WHERE client_id=?")
      .bind(JSON.stringify(["resources:write"]), t.clientId).run();
    expect((await exchange(true)).status).toBe(403);
    expect((await exchange()).status).toBe(401);
  });

});
