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

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const db = (env as unknown as TestEnv).DB;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" });
}

async function createFamily(privateKey: string, publicKey: string, ownerId: string) {
  const accessToken = await token(privateKey, ownerId, ["profile:read", "spaces:read", "spaces:write", "spaces:manage", "grants:manage"]);
  const response = await request("/api/v1/spaces", accessToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: "Lifecycle Home", ownerDisplayName: "Owner", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json<{ data: { id: string; version: number } }>();
  return { accessToken, spaceId: payload.data.id, version: payload.data.version };
}

describe("Space lifecycle", () => {
  it("lets only the owner close a Space under optimistic concurrency", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const adminId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);

    const added = await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: adminId, role: "admin", displayName: "Admin" }),
    });
    expect(added.status).toBe(201);
    const adminToken = await token(privateKey, adminId, ["spaces:read", "spaces:write", "spaces:manage"]);

    const denied = await request(`/api/v1/spaces/${family.spaceId}/close`, adminToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: family.version }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json<{ error: { code: string } }>()).error.code).toBe("SPACE_OWNER_REQUIRED");

    const stale = await request(`/api/v1/spaces/${family.spaceId}/close`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: family.version + 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("SPACE_VERSION_CONFLICT");
  });

  it("logically closes the Space and invalidates memberships, invitations, grants, and Space access", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const memberId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const db = (env as unknown as TestEnv).DB;

    expect((await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: memberId, role: "editor", displayName: "Member" }),
    })).status).toBe(201);

    const inviteResponse = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 }),
    });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json<{ data: { id: string; token: string } }>();

    const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();
    await db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(grantId, family.spaceId, "service", "svc_test", "space", null, "read", ownerId, createdAt)
      .run();

    const closed = await request(`/api/v1/spaces/${family.spaceId}/close`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: family.version }),
    });
    expect(closed.status).toBe(204);

    const space = await db.prepare("SELECT deleted_at,version FROM spaces WHERE id=?")
      .bind(family.spaceId).first<{ deleted_at: string | null; version: number }>();
    expect(space?.deleted_at).toBeTruthy();
    expect(space?.version).toBe(family.version + 1);
    expect((await db.prepare("SELECT COUNT(*) count FROM space_memberships WHERE space_id=? AND deleted_at IS NULL")
      .bind(family.spaceId).first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) count FROM space_people WHERE space_id=? AND deleted_at IS NULL")
      .bind(family.spaceId).first<{ count: number }>())?.count).toBe(0);

    const storedInvite = await db.prepare("SELECT status,revoked_at,revoked_by_user_id FROM space_invites WHERE id=?")
      .bind(invite.data.id).first<{ status: string; revoked_at: string | null; revoked_by_user_id: string | null }>();
    expect(storedInvite).toMatchObject({ status: "revoked", revoked_by_user_id: ownerId });
    expect(storedInvite?.revoked_at).toBeTruthy();
    expect((await db.prepare("SELECT revoked_at FROM data_grants WHERE id=?").bind(grantId).first<{ revoked_at: string | null }>())?.revoked_at).toBeTruthy();

    const lifecycle = await db.prepare("SELECT event_type,actor_user_id FROM space_lifecycle_events WHERE space_id=?")
      .bind(family.spaceId).first<{ event_type: string; actor_user_id: string }>();
    expect(lifecycle).toEqual({ event_type: "closed", actor_user_id: ownerId });

    const mine = await request("/api/v1/me/spaces", family.accessToken, publicKey);
    expect(mine.status).toBe(200);
    expect((await mine.json<{ data: Array<{ id: string }> }>()).data.some((item) => item.id === family.spaceId)).toBe(false);

    const oldSpace = await request(`/api/v1/spaces/${family.spaceId}`, family.accessToken, publicKey);
    expect(oldSpace.status).toBe(403);

    const memberToken = await token(privateKey, memberId, ["spaces:read", "spaces:write"]);
    const preview = await request("/api/v1/space-invites/preview", memberToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invite.data.token }),
    });
    expect(preview.status).toBe(404);
  });
});
