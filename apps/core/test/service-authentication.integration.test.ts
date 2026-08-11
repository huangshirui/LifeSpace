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

async function userToken(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "homemew-miniprogram",
    principal_type: "user",
    scope: "profile:read spaces:read spaces:write spaces:manage grants:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function identityBinding(principalId: string, scopes: string[], active = true): Fetcher {
  return {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("x-lifespace-internal-secret") !== "core-identity-test-secret-at-least-32-chars") {
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: active
          ? { active: true, audience: "lifespace-core", principal: { type: "service", id: principalId, clientId: "homemew-external", scopes, tokenId: "sat_test" } }
          : { active: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
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

describe("Core Service API Token authentication", () => {
  it("normalizes opaque tokens and intersects scope with current service Data Grant", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Home");
    const other = await createSpace(privateKey, publicKey, "Other");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;

    const grantResponse = await request(`/api/v1/spaces/${home.spaceId}/grants`, home.token, publicKey, undefined, {
      method: "POST",
      body: JSON.stringify({ granteeType: "service", granteeId: principalId, permission: "read", expiresAt: null }),
    });
    expect(grantResponse.status).toBe(201);
    const grantId = (await grantResponse.json() as { data: { id: string } }).data.id;

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

  it("rejects inactive introspection and keeps RS256 user authentication working", async () => {
    const { privateKey, publicKey } = await keys();
    const home = await createSpace(privateKey, publicKey, "Home");
    const principalId = `svc_${crypto.randomUUID().replaceAll("-", "")}`;
    const denied = await request(`/api/v1/spaces/${home.spaceId}`, "lsp_pat_inactive_token_that_is_long_enough_for_auth", publicKey, identityBinding(principalId, ["spaces:read"], false));
    expect(denied.status).toBe(401);

    const userRead = await request(`/api/v1/spaces/${home.spaceId}`, home.token, publicKey, undefined);
    expect(userRead.status).toBe(200);
  });
});
