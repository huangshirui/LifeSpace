import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type IdentityCall = { url: string; method: string; secret: string | null };
type IdentityState = "active" | "inactive" | "unavailable";

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

async function userToken(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "app_test_runtime",
    principal_type: "user",
    scope: "profile:read spaces:read spaces:write spaces:manage grants:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function serviceJwt(privateKey: string, principalId: string, clientId = "app_test_service", scope = "spaces:read") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: "service",
    scope,
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function identityBinding(
  principalId: string,
  scopes: string[],
  state: IdentityState = "active",
  calls: IdentityCall[] = [],
  displayName: string | null = "Test Automation Service",
): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        secret: request.headers.get("x-lifespace-internal-secret"),
      });
      if (request.headers.get("x-lifespace-internal-secret") !== "core-identity-test-secret-at-least-32-chars") {
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (state === "unavailable") return new Response("unavailable", { status: 503 });

      if (request.url.endsWith(`/introspection/v1/service-principals/${principalId}`)) {
        return Response.json({
          data: state === "active"
            ? { active: true, ...(displayName ? { displayName } : {}) }
            : { active: false },
        });
      }
      if (request.url.endsWith("/introspection/v1/service-tokens")) {
        return Response.json({
          data: state === "active"
            ? {
                active: true,
                audience: "lifespace-core",
                principal: {
                  type: "service",
                  id: principalId,
                  ...(displayName ? { displayName } : {}),
                  clientId: "app_test_service",
                  scopes,
                  tokenId: "sat_test",
                },
              }
            : { active: false },
        });
      }
      return new Response("not found", { status: 404 });
    },
    connect: () => { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

async function request(path: string, bearer: string, publicKey: string, identity: Fetcher | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://core.test${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    IDENTITY: identity,
    CORE_IDENTITY_SHARED_SECRET: "core-identity-test-secret-at-least-32-chars",
    ENVIRONMENT: "test",
  });
}

async function createSpace(privateKey: string, publicKey: string, name: string) {
  const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await userToken(privateKey, ownerId);
  const response = await request("/api/v1/spaces", token, publicKey, undefined, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name, ownerDisplayName: `${name} owner`, timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { data: { id: string } };
  return { ownerId, token, spaceId: body.data.id };
}

async function grantSpaceRead(home: { token: string; spaceId: string }, principalId: string, publicKey: string) {
  const response = await request(`/api/v1/spaces/${home.spaceId}/grants`, home.token, publicKey, undefined, {
    method: "POST",
    body: JSON.stringify({ granteeType: "service", granteeId: principalId, permission: "read", expiresAt: null }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { data: { id: string } }).data.id;
}

async function grantTaskWrite(home: { token: string; spaceId: string }, principalId: string, publicKey: string) {
  const db = (env as unknown as TestEnv).DB;
  await db.prepare(`INSERT OR REPLACE INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind("app_test_service", "task", "write", "service", "svc_test_admin").run();
  const response = await request(`/api/v1/spaces/${home.spaceId}/grants`, home.token, publicKey, undefined, {
    method: "POST",
    body: JSON.stringify({
      granteeType: "service",
      granteeId: principalId,
      resourceType: "model",
      resourceId: "task",
      permission: "write",
      expiresAt: null,
    }),
  });
  expect(response.status).toBe(201);
}

describe("Core service authentication", () => {
  it("normalizes opaque tokens and intersects scope with current service Data Grant", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Home");
    const other = await createSpace(privateKey, publicKey, "Other");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;

    const grantId = await grantSpaceRead(home, principalId, publicKey);

    const serviceToken = "lsp_pat_test_secret_that_is_long_enough_for_core_authentication";
    const identity = identityBinding(principalId, ["spaces:read"]);
    const allowed = await request(`/api/v1/spaces/${home.spaceId}`, serviceToken, publicKey, identity);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ data: { id: home.spaceId, access: "grant" } });

    const crossSpace = await request(`/api/v1/spaces/${other.spaceId}`, serviceToken, publicKey, identity);
    expect(crossSpace.status).toBe(403);

    const noScope = await request(`/api/v1/spaces/${home.spaceId}`, serviceToken, publicKey, identityBinding(principalId, []));
    expect(noScope.status).toBe(403);

    const list = await request(`/api/v1/spaces/${home.spaceId}/grants`, home.token, publicKey, undefined);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ data: [{ id: grantId, granteeType: "service", granteeId: principalId, permission: "read" }] });

    const revoked = await request(`/api/v1/spaces/${home.spaceId}/grants/${grantId}`, home.token, publicKey, undefined, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    const afterRevoke = await request(`/api/v1/spaces/${home.spaceId}`, serviceToken, publicKey, identity);
    expect(afterRevoke.status).toBe(403);
  });

  it("returns trusted service display names in Generic Resource audit fields for opaque tokens and service JWTs", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Audit Home");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    await grantTaskWrite(home, principalId, publicKey);
    const identity = identityBinding(principalId, ["resources:read", "resources:write"]);
    const serviceToken = "lsp_pat_audit_token_that_is_long_enough_for_core_authentication";
    const collection = `/api/v1/spaces/${home.spaceId}/models/task/records`;

    const createdResponse = await request(collection, serviceToken, publicKey, identity, {
      method: "POST",
      body: JSON.stringify({ name: "Created by automation" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { data: {
      id: string;
      version: number;
      createdBy: { type: string; id: string; displayName: string };
      updatedBy: { type: string; id: string; displayName: string };
    } };
    expect(created.data.createdBy).toEqual({ type: "service", id: principalId, displayName: "Test Automation Service" });
    expect(created.data.updatedBy).toEqual({ type: "service", id: principalId, displayName: "Test Automation Service" });

    const jwt = await serviceJwt(privateKey, principalId, "app_test_service", "resources:read resources:write");
    const updatedResponse = await request(`${collection}/${created.data.id}`, jwt, publicKey, identity, {
      method: "PATCH",
      body: JSON.stringify({ version: created.data.version, name: "Updated by automation" }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json() as { data: {
      createdBy: { type: string; id: string; displayName: string };
      updatedBy: { type: string; id: string; displayName: string };
    } };
    expect(updated.data.createdBy).toEqual({ type: "service", id: principalId, displayName: "Test Automation Service" });
    expect(updated.data.updatedBy).toEqual({ type: "service", id: principalId, displayName: "Test Automation Service" });
  });

  it("rejects inactive opaque-token introspection and keeps RS256 user authentication working", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Home");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const denied = await request(
      `/api/v1/spaces/${home.spaceId}`,
      "lsp_pat_inactive_token_that_is_long_enough_for_auth",
      publicKey,
      identityBinding(principalId, ["spaces:read"], "inactive"),
    );
    expect(denied.status).toBe(401);

    const userRead = await request(`/api/v1/spaces/${home.spaceId}`, home.token, publicKey, undefined);
    expect(userRead.status).toBe(200);
  });

  it("rechecks current Service Principal eligibility exactly once for each already-issued service JWT request", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "JWT Home");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    await grantSpaceRead(home, principalId, publicKey);
    const bearer = await serviceJwt(privateKey, principalId);
    const calls: IdentityCall[] = [];
    const activeIdentity = identityBinding(principalId, ["spaces:read"], "active", calls);

    const allowed = await request(`/api/v1/spaces/${home.spaceId}`, bearer, publicKey, activeIdentity);
    expect(allowed.status).toBe(200);
    expect(calls).toEqual([{
      url: `https://identity.internal/introspection/v1/service-principals/${principalId}`,
      method: "GET",
      secret: "core-identity-test-secret-at-least-32-chars",
    }]);

    // The same cryptographically valid JWT must not preserve authority after Identity
    // reports the principal/application inactive. Identity's own contract tests prove
    // that either Service Principal disablement or owning Application disablement
    // produces this same current active=false result.
    const denied = await request(
      `/api/v1/spaces/${home.spaceId}`,
      bearer,
      publicKey,
      identityBinding(principalId, ["spaces:read"], "inactive"),
    );
    expect(denied.status).toBe(401);

    const unavailable = await request(
      `/api/v1/spaces/${home.spaceId}`,
      bearer,
      publicKey,
      identityBinding(principalId, ["spaces:read"], "unavailable"),
    );
    expect(unavailable.status).toBe(401);
  });

  it("keeps service authentication compatible during Core-first rollout when older Identity omits displayName", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Rollout Home");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    await grantSpaceRead(home, principalId, publicKey);
    const legacyIdentity = identityBinding(principalId, ["spaces:read"], "active", [], null);

    const opaque = await request(
      `/api/v1/spaces/${home.spaceId}`,
      "lsp_pat_legacy_identity_token_that_is_long_enough_for_auth",
      publicKey,
      legacyIdentity,
    );
    expect(opaque.status).toBe(200);

    const jwt = await serviceJwt(privateKey, principalId);
    const jwtResponse = await request(`/api/v1/spaces/${home.spaceId}`, jwt, publicKey, legacyIdentity);
    expect(jwtResponse.status).toBe(200);
  });

  it("does not add a Service Principal eligibility read to ordinary user JWT requests", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "User Home");
    const calls: IdentityCall[] = [];
    const identity = identityBinding(`svc_${crypto.randomUUID().replaceAll("-", "")}`, ["spaces:read"], "active", calls);

    const response = await request(`/api/v1/spaces/${home.spaceId}`, home.token, publicKey, identity);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
