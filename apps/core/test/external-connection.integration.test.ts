import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

const shared = "synthetic-external-shared-secret-at-least-32-chars";
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
async function userToken(privateKey: string, userId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "external-config-test",
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function adapter(calls: Array<Record<string, unknown>>) {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      expect(request.headers.get("x-lifespace-internal-secret")).toBe(shared);
      const body = await request.json<Record<string, unknown>>();
      calls.push({ path: new URL(request.url).pathname, ...body });
      if (new URL(request.url).pathname === "/internal/v1/external-connections") {
        if (body.operation === "describe") {
          return Response.json({ contractVersion: 1, data: {
            key: "notion",
            displayName: "Notion",
            credential: { type: "bearer_token", displayName: "Integration token" },
            resource: { type: "data_source", displayName: "Data source" },
            access: ["read", "write"],
          } });
        }
        if (body.operation === "listResources") {
          return Response.json({ contractVersion: 1, data: {
            items: [{ id: "123456781234123412341234567890ab", type: "data_source", displayName: "Health Documents" }],
            nextCursor: null,
          } });
        }
        if (body.operation === "delete") return Response.json({ contractVersion: 1, data: { deleted: true } });
        return Response.json({ contractVersion: 1, data: { read: true, write: body.access === "write" } });
      }
      const operation = body.operation;
      if (operation === "discover") {
        return Response.json({ contractVersion: 1, data: {
          resourceId: String(body.resourceId),
          displayName: "Health Documents",
          fields: [{
            key: "f_" + "a".repeat(32), sourceFieldId: "title", title: "Name", type: "string",
            nullable: false, readable: true, writable: true, operators: ["eq", "ne", "contains"], sortable: true,
          }],
          capabilities: {
            get: true, query: true, create: true, update: true, delete: true, batchWrite: true,
            atomicBatch: false, transaction: false, versionedWrite: false, actions: false, relationTargetResolution: false,
          },
          queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
          adapterState: { codecs: {} },
        } });
      }
      if (operation === "connection") return Response.json({ contractVersion: 1, data: { read: true, write: true } });
      return Response.json({ contractVersion: 1, data: {} });
    },
  } as Fetcher;
}

async function request(path: string, accessToken: string, publicKey: string, external: Fetcher, init: RequestInit = {}) {
  const db = (env as unknown as TestEnv).DB;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    EXTERNAL_ADAPTER: external,
    EXTERNAL_ADAPTER_SHARED_SECRET: shared,
    EXTERNAL_SCHEMA_REFRESH_SECONDS: "300",
  });
}

async function fixture() {
  const keyPair = await keys();
  const userId = `usr_${crypto.randomUUID()}`;
  const token = await userToken(keyPair.privateKey, userId, ["profile:read", "spaces:read", "spaces:write", "spaces:manage"]);
  const calls: Array<Record<string, unknown>> = [];
  const external = adapter(calls);
  const created = await request("/api/v1/spaces", token, keyPair.publicKey, external, {
    method: "POST",
    body: JSON.stringify({ name: "External config", ownerDisplayName: "Owner", timezone: "Asia/Tokyo" }),
  });
  expect(created.status).toBe(201);
  const spaceId = (await created.json<{ data: { id: string } }>()).data.id;
  return { ...keyPair, token, spaceId, external, calls };
}

describe("Space External Connection configuration", () => {
  it("creates a managed connection without persisting or returning provider credential plaintext", async () => {
    const f = await fixture();
    const providers = await request(`/api/v1/spaces/${f.spaceId}/external-providers`, f.token, f.publicKey, f.external);
    expect(providers.status).toBe(200);
    expect((await providers.json<{ data: { items: Array<{ key: string }> } }>()).data.items[0]?.key).toBe("notion");

    const providerToken = "secret_provider_token_never_in_core";
    const created = await request(`/api/v1/spaces/${f.spaceId}/external-connections`, f.token, f.publicKey, f.external, {
      method: "POST",
      body: JSON.stringify({
        providerKey: "notion",
        displayName: "Personal Notion",
        credential: { type: "bearer_token", token: providerToken },
        access: "write",
      }),
    });
    expect(created.status).toBe(201);
    const result = await created.json<{ data: { id: string; providerKey: string; access: string; credentialMode: string } }>();
    expect(result.data.id).toMatch(/^exc_[a-f0-9]{32}$/u);
    expect(result.data).toMatchObject({ providerKey: "notion", access: "write", credentialMode: "managed" });
    expect(JSON.stringify(result)).not.toContain(providerToken);
    expect(JSON.stringify(result)).not.toContain("cnx_");

    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT credential_ref,display_name,access_mode,credential_mode FROM external_sources WHERE id=?")
      .bind(result.data.id).first<{ credential_ref: string; display_name: string; access_mode: string; credential_mode: string }>();
    expect(row?.credential_ref).toMatch(/^cnx_[a-f0-9]{32}$/u);
    expect(row).toMatchObject({ display_name: "Personal Notion", access_mode: "write", credential_mode: "managed" });
    expect(JSON.stringify(row)).not.toContain(providerToken);
    expect(f.calls.some((call) => JSON.stringify(call).includes(providerToken))).toBe(true);
  });

  it("discovers provider resources, rotates credential metadata, and binds by connectionId", async () => {
    const f = await fixture();
    const created = await request(`/api/v1/spaces/${f.spaceId}/external-connections`, f.token, f.publicKey, f.external, {
      method: "POST",
      body: JSON.stringify({ providerKey: "notion", displayName: "Notion", credential: { type: "bearer_token", token: "first_token" }, access: "write" }),
    });
    const connectionId = (await created.json<{ data: { id: string } }>()).data.id;

    const resources = await request(`/api/v1/spaces/${f.spaceId}/external-connections/${connectionId}/resources?limit=20`, f.token, f.publicKey, f.external);
    expect(resources.status).toBe(200);
    expect((await resources.json<{ data: { items: Array<{ displayName: string }> } }>()).data.items[0]?.displayName).toBe("Health Documents");

    const updated = await request(`/api/v1/spaces/${f.spaceId}/external-connections/${connectionId}`, f.token, f.publicKey, f.external, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Health Notion", access: "read", credential: { type: "bearer_token", token: "rotated_token" } }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: { displayName: string; access: string } }>()).data).toMatchObject({ displayName: "Health Notion", access: "read" });

    const binding = await request(`/api/v1/spaces/${f.spaceId}/external-models`, f.token, f.publicKey, f.external, {
      method: "POST",
      body: JSON.stringify({ connectionId, resourceId: "123456781234123412341234567890ab", declaredAccess: "read" }),
    });
    expect(binding.status).toBe(201);
    expect(JSON.stringify(await binding.json())).toContain("Health Documents");

    const listed = await request(`/api/v1/spaces/${f.spaceId}/external-models`, f.token, f.publicKey, f.external);
    const payload = await listed.json<{ data: { items: Array<{ connectionId: string; sourceId: string }> } }>();
    expect(payload.data.items[0]).toMatchObject({ connectionId, sourceId: connectionId });
  });

  it("does not let an ordinary Space manager submit a server credentialRef", async () => {
    const f = await fixture();
    const response = await request(`/api/v1/spaces/${f.spaceId}/external-connections`, f.token, f.publicKey, f.external, {
      method: "POST",
      body: JSON.stringify({ providerKey: "notion", displayName: "Bad", credentialRef: "notion_smoke_staging", access: "write" }),
    });
    expect(response.status).toBe(400);
    expect(f.calls.some((call) => call.credentialRef === "notion_smoke_staging")).toBe(false);
  });
});
