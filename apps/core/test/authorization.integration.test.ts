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

async function token(privateKey: string, userId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, options: RequestInit, publicKey: string) {
  const db = (env as unknown as TestEnv).DB;
  return createApp().request(`http://localhost${path}`, options, { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" });
}

async function seedSpace(spaceId: string, ownerId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(spaceId, "family", `Space ${spaceId}`, ownerId, now, now).run();
  await db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(`mem_${crypto.randomUUID()}`, spaceId, ownerId, "owner", now, now).run();
  await db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(`per_${crypto.randomUUID()}`, spaceId, ownerId, "Owner", now, now).run();
}

describe("D1-backed Core authorization", () => {
  it("requires both app scope and Space permission for management", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const viewerId = `usr_${crypto.randomUUID()}`;
    const newMemberId = `usr_${crypto.randomUUID()}`;
    const spaceId = `spc_${crypto.randomUUID()}`;
    await seedSpace(spaceId, ownerId);
    const db = (env as unknown as TestEnv).DB;
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .bind(`mem_${crypto.randomUUID()}`, spaceId, viewerId, "viewer", now, now).run();

    const ownerWithoutScope = await token(privateKey, ownerId, ["spaces:read"]);
    const missingScope = await request(`/api/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerWithoutScope}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: newMemberId, role: "viewer", displayName: "New" }),
    }, publicKey);
    expect(missingScope.status).toBe(403);

    const viewerWithScope = await token(privateKey, viewerId, ["spaces:manage"]);
    const missingDataPermission = await request(`/api/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewerWithScope}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: newMemberId, role: "viewer", displayName: "New" }),
    }, publicKey);
    expect(missingDataPermission.status).toBe(403);

    const ownerWithScope = await token(privateKey, ownerId, ["spaces:manage"]);
    const allowed = await request(`/api/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerWithScope}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: newMemberId, role: "viewer", displayName: "New" }),
    }, publicKey);
    expect(allowed.status).toBe(201);
  });

  it("enforces Data Grant rank, expiry and revocation", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const granteeId = `usr_${crypto.randomUUID()}`;
    const spaceId = `spc_${crypto.randomUUID()}`;
    await seedSpace(spaceId, ownerId);
    const db = (env as unknown as TestEnv).DB;
    const createdAt = new Date().toISOString();
    const grantId = `grt_${crypto.randomUUID()}`;
    await db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(grantId, spaceId, "user", granteeId, "space", null, "read", ownerId, createdAt).run();

    const readToken = await token(privateKey, granteeId, ["spaces:read"]);
    expect((await request(`/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${readToken}` } }, publicKey)).status).toBe(200);

    const manageToken = await token(privateKey, granteeId, ["spaces:manage"]);
    expect((await request(`/api/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${manageToken}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: `usr_${crypto.randomUUID()}`, role: "viewer", displayName: "Denied" }),
    }, publicKey)).status).toBe(403);

    await db.prepare(`UPDATE data_grants SET revoked_at=? WHERE id=?`).bind(new Date().toISOString(), grantId).run();
    expect((await request(`/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${readToken}` } }, publicKey)).status).toBe(403);

    const expiredId = `grt_${crypto.randomUUID()}`;
    await db.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(expiredId, spaceId, "user", granteeId, "space", null, "manage", ownerId, createdAt, "2000-01-01T00:00:00.000Z").run();
    expect((await request(`/api/v1/spaces/${spaceId}`, { headers: { authorization: `Bearer ${readToken}` } }, publicKey)).status).toBe(403);
  });

  it("isolates Spaces without membership or a grant", async () => {
    const { privateKey, publicKey } = await keys();
    const userA = `usr_${crypto.randomUUID()}`;
    const userB = `usr_${crypto.randomUUID()}`;
    const spaceA = `spc_${crypto.randomUUID()}`;
    const spaceB = `spc_${crypto.randomUUID()}`;
    await seedSpace(spaceA, userA);
    await seedSpace(spaceB, userB);

    const userAToken = await token(privateKey, userA, ["spaces:read"]);
    expect((await request(`/api/v1/spaces/${spaceA}`, { headers: { authorization: `Bearer ${userAToken}` } }, publicKey)).status).toBe(200);
    expect((await request(`/api/v1/spaces/${spaceB}`, { headers: { authorization: `Bearer ${userAToken}` } }, publicKey)).status).toBe(403);
  });
});
