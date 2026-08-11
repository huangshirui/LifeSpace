import { env } from "cloudflare:workers";
import { verify } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database; ASSETS: R2Bucket };

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

function bindings(privateKey: string, publicKey: string) {
  const test = env as unknown as TestEnv;
  return {
    DB: test.DB,
    ASSETS: test.ASSETS,
    TOKEN_PUBLIC_KEY: publicKey,
    TOKEN_PRIVATE_KEY: privateKey,
    BOOTSTRAP_SECRET: "test-bootstrap-secret-at-least-32-characters",
    CORE_IDENTITY_SHARED_SECRET: "test-core-identity-shared-secret-at-least-32",
    ENVIRONMENT: "test",
  };
}

async function setup(allowedScopes = ["spaces:read", "events:read", "events:write", "tasks:read"]) {
  const pair = await keys();
  const app = createApp();
  const b = bindings(pair.privateKey, pair.publicKey);
  const appId = `app_service_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const registered = await app.request("http://identity.test/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": b.BOOTSTRAP_SECRET },
    body: JSON.stringify({ id: appId, name: "Service auth test", clientType: "service", trustedBackend: true, allowedScopes, accessTokenTtlSeconds: 300 }),
  }, b);
  expect(registered.status).toBe(201);
  const registeredBody = await registered.json() as { data: { clientSecret: string } };
  const clientSecret = registeredBody.data.clientSecret;

  const createdUser = await app.request("http://identity.test/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Integration owner" }),
  }, b);
  expect(createdUser.status).toBe(201);
  const userId = (await createdUser.json() as { data: { id: string } }).data.id;

  const principal = await app.request("http://identity.test/api/v1/service-principals", {
    method: "POST",
    headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Home n8n", description: "Owner-controlled automation", maxScopes: allowedScopes, createdByUserId: userId }),
  }, b);
  expect(principal.status).toBe(201);
  const principalId = (await principal.json() as { data: { id: string } }).data.id;
  return { app, b, pair, appId, clientSecret, userId, principalId };
}

describe("Identity service authentication", () => {
  it("returns opaque plaintext once, introspects current state, reduces scope, and revokes immediately", async () => {
    const { app, b, clientSecret, userId, principalId } = await setup();
    const created = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "n8n primary", scopes: ["events:read", "events:write"], createdByUserId: userId }),
    }, b);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; token: string; displayPrefix: string; lastFour: string } };
    expect(createdBody.data.token).toMatch(/^lsp_pat_[A-Za-z0-9_-]{40,}$/);
    expect(createdBody.data.displayPrefix).toBe(createdBody.data.token.slice(0, 16));
    expect(createdBody.data.lastFour).toBe(createdBody.data.token.slice(-4));

    const listed = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens`, {
      headers: { authorization: `Bearer ${clientSecret}` },
    }, b);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(createdBody.data.token);
    expect(listedText).not.toContain("tokenHash");

    const introspected = await app.request("http://identity.test/introspection/v1/service-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${createdBody.data.token}`, "x-lifespace-internal-secret": b.CORE_IDENTITY_SHARED_SECRET },
    }, b);
    expect(introspected.status).toBe(200);
    expect(await introspected.json()).toMatchObject({ data: { active: true, audience: "lifespace-core", principal: { type: "service", id: principalId, scopes: ["events:read", "events:write"] } } });

    const reduced = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens/${createdBody.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["events:read"] }),
    }, b);
    expect(reduced.status).toBe(200);

    const reducedIntrospection = await app.request("http://identity.test/introspection/v1/service-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${createdBody.data.token}`, "x-lifespace-internal-secret": b.CORE_IDENTITY_SHARED_SECRET },
    }, b);
    expect(await reducedIntrospection.json()).toMatchObject({ data: { active: true, principal: { scopes: ["events:read"] } } });

    const revoked = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens/${createdBody.data.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${clientSecret}` },
    }, b);
    expect(revoked.status).toBe(204);

    const revokedIntrospection = await app.request("http://identity.test/introspection/v1/service-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${createdBody.data.token}`, "x-lifespace-internal-secret": b.CORE_IDENTITY_SHARED_SECRET },
    }, b);
    expect(await revokedIntrospection.json()).toEqual({ data: { active: false } });
  });

  it("enforces application/principal ceilings and disabled-principal current state", async () => {
    const { app, b, clientSecret, userId, principalId } = await setup(["events:read"]);
    const tooBroad = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "too broad", scopes: ["events:write"], createdByUserId: userId }),
    }, b);
    expect(tooBroad.status).toBe(403);

    const created = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "reader", scopes: ["events:read"] }),
    }, b);
    const token = (await created.json() as { data: { token: string } }).data.token;

    const disabled = await app.request(`http://identity.test/api/v1/service-principals/${principalId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    }, b);
    expect(disabled.status).toBe(200);

    const introspected = await app.request("http://identity.test/introspection/v1/service-tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-lifespace-internal-secret": b.CORE_IDENTITY_SHARED_SECRET },
    }, b);
    expect(await introspected.json()).toEqual({ data: { active: false } });

    const malformed = await app.request("http://identity.test/introspection/v1/service-tokens", {
      method: "POST",
      headers: { authorization: "Bearer lsp_pat_invalid", "x-lifespace-internal-secret": b.CORE_IDENTITY_SHARED_SECRET },
    }, b);
    expect(await malformed.json()).toEqual({ data: { active: false } });
  });

  it("issues short-lived OAuth client_credentials JWTs for the same service principal", async () => {
    const { app, b, pair, appId, clientSecret, userId, principalId } = await setup(["events:read", "tasks:read"]);
    const createdCredential = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/oauth-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "third party", createdByUserId: userId }),
    }, b);
    expect(createdCredential.status).toBe(201);
    const credential = await createdCredential.json() as { data: { id: string; clientId: string; clientSecret: string } };
    expect(credential.data.clientId).toBe(principalId);
    expect(credential.data.clientSecret).toMatch(/^lsp_client_/);

    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: principalId, client_secret: credential.data.clientSecret, scope: "events:read" });
    const tokenResponse = await app.request("http://identity.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, b);
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as { access_token: string; token_type: string; expires_in: number; scope: string };
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(300);
    const payload = await verify(tokenBody.access_token, pair.publicKey, "RS256");
    expect(payload).toMatchObject({ iss: "lifespace-identity", aud: "lifespace-core", sub: principalId, azp: appId, principal_type: "service", scope: "events:read" });

    const wrongClient = new URLSearchParams({ grant_type: "client_credentials", client_id: `svc_${crypto.randomUUID().replaceAll("-", "")}`, client_secret: credential.data.clientSecret, scope: "events:read" });
    const denied = await app.request("http://identity.test/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: wrongClient.toString(),
    }, b);
    expect(denied.status).toBe(401);

    const revoked = await app.request(`http://identity.test/api/v1/service-principals/${principalId}/oauth-credentials/${credential.data.id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${clientSecret}` },
    }, b);
    expect(revoked.status).toBe(204);
    const afterRevoke = await app.request("http://identity.test/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    }, b);
    expect(afterRevoke.status).toBe(401);
  });
});
