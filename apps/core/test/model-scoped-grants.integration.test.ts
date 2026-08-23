import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type PrincipalType = "user" | "service";

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

async function token(privateKey: string, principalId: string, clientId: string, principalType: PrincipalType, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const ownerId = `usr_${suffix}`;
  const serviceId = `svc_${suffix}`;
  const clientId = `app_integration_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const modelKey = `note_${suffix.slice(0, 10)}`;
  const route = `notes-${suffix.slice(0, 10)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Model Grant Test", ownerId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, ownerId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, ownerId, "Owner", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    route,
    display: { singular: "Note", plural: "Notes" },
    fields: { title: { type: "string", required: true, minLength: 1, maxLength: 120 } },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");

  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

  const ownerToken = await token(privateKey, ownerId, clientId, "user", ["grants:manage"]);
  const serviceToken = await token(privateKey, serviceId, clientId, "service", ["resources:read", "resources:write", "spaces:read"]);
  return { db, privateKey, publicKey, ownerId, serviceId, clientId, spaceId, modelKey, route, ownerToken, serviceToken };
}

describe("model-scoped Data Grants", () => {
  it("limits a service principal to the granted model while preserving whole-Space fallback", async () => {
    const f = await fixture();
    const modelPath = `/api/v1/spaces/${f.spaceId}/${f.route}`;

    expect((await request(f.publicKey, f.serviceToken, modelPath)).status).toBe(403);

    const wrongGrantId = `grt_${crypto.randomUUID()}`;
    await f.db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      wrongGrantId, f.spaceId, "service", f.serviceId, "model", `other_${f.modelKey}`, "write", f.ownerId, new Date().toISOString(),
    ).run();
    expect((await request(f.publicKey, f.serviceToken, modelPath)).status).toBe(403);

    const modelGrantId = `grt_${crypto.randomUUID()}`;
    await f.db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      modelGrantId, f.spaceId, "service", f.serviceId, "model", f.modelKey, "read", f.ownerId, new Date().toISOString(),
    ).run();

    expect((await request(f.publicKey, f.serviceToken, modelPath)).status).toBe(200);
    expect((await request(f.publicKey, f.serviceToken, `/api/v1/spaces/${f.spaceId}`)).status).toBe(403);
    expect((await request(f.publicKey, f.serviceToken, modelPath, {
      method: "POST",
      body: JSON.stringify({ title: "Denied until write is granted" }),
    })).status).toBe(403);

    await f.db.prepare("UPDATE data_grants SET permission='write' WHERE id=?").bind(modelGrantId).run();
    expect((await request(f.publicKey, f.serviceToken, modelPath, {
      method: "POST",
      body: JSON.stringify({ title: "Allowed by model grant" }),
    })).status).toBe(201);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), modelGrantId).run();
    expect((await request(f.publicKey, f.serviceToken, modelPath)).status).toBe(403);

    await f.db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      `grt_${crypto.randomUUID()}`, f.spaceId, "service", f.serviceId, "space", null, "read", f.ownerId, new Date().toISOString(),
    ).run();
    expect((await request(f.publicKey, f.serviceToken, modelPath)).status).toBe(200);
    expect((await request(f.publicKey, f.serviceToken, `/api/v1/spaces/${f.spaceId}`)).status).toBe(200);
  });

  it("creates backwards-compatible Space grants and explicit model grants through the Kernel API", async () => {
    const f = await fixture();

    const legacy = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST",
      body: JSON.stringify({ granteeType: "service", granteeId: f.serviceId, permission: "read" }),
    });
    expect(legacy.status).toBe(201);
    expect((await legacy.json<{ data: { resourceType: string; resourceId: string | null } }>()).data)
      .toMatchObject({ resourceType: "space", resourceId: null });

    const model = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST",
      body: JSON.stringify({
        granteeType: "service",
        granteeId: f.serviceId,
        resourceType: "model",
        resourceId: f.modelKey,
        permission: "write",
      }),
    });
    expect(model.status).toBe(201);
    expect((await model.json<{ data: { resourceType: string; resourceId: string | null; permission: string } }>()).data)
      .toMatchObject({ resourceType: "model", resourceId: f.modelKey, permission: "write" });

    const unknownModel = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST",
      body: JSON.stringify({
        granteeType: "service",
        granteeId: f.serviceId,
        resourceType: "model",
        resourceId: `missing_${crypto.randomUUID()}`,
        permission: "read",
      }),
    });
    expect(unknownModel.status).toBe(404);

    const freeBusyModel = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/grants`, {
      method: "POST",
      body: JSON.stringify({
        granteeType: "service",
        granteeId: f.serviceId,
        resourceType: "model",
        resourceId: f.modelKey,
        permission: "free_busy",
      }),
    });
    expect(freeBusyModel.status).toBe(422);

    const listed = await request(f.publicKey, f.ownerToken, `/api/v1/spaces/${f.spaceId}/grants`);
    expect(listed.status).toBe(200);
    const payload = await listed.json<{ data: Array<{ resourceType: string; resourceId: string | null }> }>();
    expect(payload.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "space", resourceId: null }),
      expect.objectContaining({ resourceType: "model", resourceId: f.modelKey }),
    ]));
  });
});
