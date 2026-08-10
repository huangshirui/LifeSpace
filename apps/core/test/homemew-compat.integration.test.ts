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

async function token(privateKey: string, userId: string, clientId = "homemew-miniprogram") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "spaces:read spaces:write spaces:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const db = (env as TestEnv).DB;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" });
}

async function mapUser(userId: string, displayName: string) {
  const db = (env as TestEnv).DB;
  await db.prepare(`INSERT INTO legacy_homemew_user_maps(
    legacy_user_id,lifespace_user_id,display_name_snapshot,source_status,migrated_at) VALUES(?,?,?,'active',?)`)
    .bind(userId, userId, displayName, new Date().toISOString()).run();
}

async function createFamily(accessToken: string, publicKey: string, name = "Home") {
  const response = await request("/api/v1/families", accessToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ name, timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  return response.json<{ data: { id: string; role: string; memberCount: number } }>();
}

describe("HomeMew family compatibility", () => {
  it("rejects a non-HomeMew application even when its generic scopes are broad enough", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(userId, "User");
    const otherAppToken = await token(privateKey, userId, "aloha-web");
    const response = await request("/api/v1/me/families", otherAppToken, publicKey);
    expect(response.status).toBe(403);
  });

  it("maps legacy family responses over the same Space records", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const created = await createFamily(accessToken, publicKey);
    expect(created.data).toMatchObject({ role: "admin", memberCount: 1 });
    expect(created.data.id).toMatch(/^fam_/);

    const db = (env as TestEnv).DB;
    const mapping = await db.prepare(`SELECT fm.space_id,s.kind,m.role FROM legacy_homemew_family_maps fm
      JOIN spaces s ON s.id=fm.space_id JOIN space_memberships m ON m.space_id=s.id AND m.user_id=?
      WHERE fm.legacy_family_id=?`).bind(ownerId, created.data.id).first<{ space_id: string; kind: string; role: string }>();
    expect(mapping).toMatchObject({ kind: "family", role: "owner" });
    expect(mapping?.space_id).toMatch(/^spc_/);

    const listed = await request("/api/v1/me/families", accessToken, publicKey);
    expect((await listed.json<{ data: { items: Array<{ id: string; avatarUrl: null; role: string }> } }>()).data.items)
      .toContainEqual(expect.objectContaining({ id: created.data.id, avatarUrl: null, role: "admin" }));
    const detail = await request(`/api/v1/families/${created.data.id}`, accessToken, publicKey);
    expect((await detail.json<{ data: { id: string; currentUserRole: string } }>()).data)
      .toMatchObject({ id: created.data.id, currentUserRole: "admin" });
  });

  it("keeps the three-created-family rule only on the compatibility route", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    for (let index = 0; index < 2; index += 1) await createFamily(accessToken, publicKey, `Home ${index}`);
    const candidates = await Promise.all([3, 4].map((index) => request("/api/v1/families", accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: `Home ${index}` }),
    })));
    expect(candidates.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = candidates.find((response) => response.status === 409);
    expect((await rejected?.json<{ error: { code: string } }>())?.error.code).toBe("FAMILY_CREATE_LIMIT_REACHED");

    const native = await request("/api/v1/spaces", accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ kind: "family", name: "Native family", ownerDisplayName: "Owner" }),
    });
    expect(native.status).toBe(201);
  });

  it("preserves member and invitation shapes while mutating native records", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId);
    const memberToken = await token(privateKey, memberId);
    const created = await createFamily(ownerToken, publicKey);

    const inviteResponse = await request(`/api/v1/families/${created.data.id}/invites`, ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ maxUses: 2, expiresInMinutes: 60 }),
    });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json<{ data: { code: string; joinPath: string } }>();
    expect(invite.data.joinPath).toBe(`pages/family/join?code=${invite.data.code}`);

    const preview = await request(`/api/v1/family-invites/${invite.data.code}`, memberToken, publicKey);
    expect((await preview.json<{ data: { family: { id: string }; canJoin: boolean } }>()).data)
      .toMatchObject({ family: { id: created.data.id }, canJoin: true });
    const joined = await request(`/api/v1/family-invites/${invite.data.code}/join`, memberToken, publicKey, { method: "POST" });
    expect(joined.status).toBe(200);
    expect((await joined.json<{ data: { familyId: string; role: string } }>()).data)
      .toMatchObject({ familyId: created.data.id, role: "member" });

    const members = await request(`/api/v1/families/${created.data.id}/members`, ownerToken, publicKey);
    expect((await members.json<{ data: { items: Array<{ userId: string; displayName: string; avatarUrl: null; role: string }> } }>()).data.items)
      .toContainEqual(expect.objectContaining({ userId: memberId, displayName: "Member", avatarUrl: null, role: "member" }));

    const db = (env as TestEnv).DB;
    const space = await db.prepare(`SELECT space_id FROM legacy_homemew_family_maps WHERE legacy_family_id=?`)
      .bind(created.data.id).first<{ space_id: string }>();
    expect(await db.prepare(`SELECT role FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL`)
      .bind(space?.space_id, memberId).first()).toMatchObject({ role: "editor" });

    expect((await request(`/api/v1/families/${created.data.id}/leave`, memberToken, publicKey, { method: "POST" })).status).toBe(204);
    const replay = await request(`/api/v1/family-invites/${invite.data.code}/join`, memberToken, publicKey, { method: "POST" });
    expect(replay.status).toBe(409);
    expect((await replay.json<{ error: { code: string } }>()).error.code).toBe("ALREADY_FAMILY_MEMBER");
  });
});
