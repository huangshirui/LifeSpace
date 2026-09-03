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

async function createFamily(privateKey: string, publicKey: string, userId: string) {
  const accessToken = await token(privateKey, userId, ["profile:read", "spaces:read", "spaces:write", "spaces:manage"]);
  const response = await request("/api/v1/spaces", accessToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: "Home", ownerDisplayName: "Owner", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json<{ data: { id: string; version: number } }>();
  return { accessToken, spaceId: payload.data.id, version: payload.data.version };
}

describe("Phase 2 family Space management", () => {
  it("stores IANA timezone and enforces optimistic Space updates", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);

    const updated = await request(`/api/v1/spaces/${family.spaceId}`, family.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ name: "Home 2", timezone: "Asia/Tokyo", version: 1 }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: { timezone: string; version: number } }>()).data).toMatchObject({ timezone: "Asia/Tokyo", version: 2 });

    const stale = await request(`/api/v1/spaces/${family.spaceId}`, family.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ name: "Stale", version: 1 }),
    });
    expect(stale.status).toBe(409);
  });

  it("stores only invite hashes and atomically creates membership plus Space Person", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const joiningId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const created = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ role: "editor", maxUses: 1, expiresInMinutes: 60 }),
    });
    expect(created.status).toBe(201);
    const invitation = await created.json<{ data: { id: string; token: string } }>();
    const db = (env as unknown as TestEnv).DB;
    const stored = await db.prepare("SELECT token_hash FROM space_invites WHERE id=?").bind(invitation.data.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toBeTruthy();
    expect(stored?.token_hash).not.toContain(invitation.data.token);

    const listed = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey);
    expect(JSON.stringify(await listed.json())).not.toContain(invitation.data.token);

    const joiningToken = await token(privateKey, joiningId, ["spaces:read", "spaces:write"]);
    const preview = await request("/api/v1/space-invites/preview", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json<{ data: { space: { id: string }; canJoin: boolean } }>()).data)
      .toMatchObject({ space: { id: family.spaceId }, canJoin: true });

    const joined = await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token, displayName: "New member" }),
    });
    expect(joined.status).toBe(201);
    const membership = await db.prepare("SELECT role FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
      .bind(family.spaceId, joiningId).first<{ role: string }>();
    const person = await db.prepare("SELECT display_name FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL")
      .bind(family.spaceId, joiningId).first<{ display_name: string }>();
    expect(membership?.role).toBe("editor");
    expect(person?.display_name).toBe("New member");

    const replay = await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token, displayName: "Again" }),
    });
    expect(replay.status).toBe(409);
  });

  it("preserves a family Space manager and deactivates membership with its person", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const memberId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);

    const cannotLeave = await request(`/api/v1/spaces/${family.spaceId}/leave`, family.accessToken, publicKey, { method: "POST" });
    expect(cannotLeave.status).toBe(409);

    const added = await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: memberId, role: "editor", displayName: "Member" }),
    });
    expect(added.status).toBe(201);
    const memberToken = await token(privateKey, memberId, ["spaces:read", "spaces:write"]);
    const removed = await request(`/api/v1/spaces/${family.spaceId}/leave`, memberToken, publicKey, { method: "POST" });
    expect(removed.status).toBe(204);
    const db = (env as unknown as TestEnv).DB;
    expect((await db.prepare("SELECT deleted_at FROM space_memberships WHERE space_id=? AND user_id=?").bind(family.spaceId, memberId).first<{ deleted_at: string | null }>())?.deleted_at).toBeTruthy();
    expect((await db.prepare("SELECT deleted_at FROM space_people WHERE space_id=? AND linked_user_id=?").bind(family.spaceId, memberId).first<{ deleted_at: string | null }>())?.deleted_at).toBeTruthy();
  });

  it("enforces the family Space limit of eight active members", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    for (let index = 0; index < 7; index += 1) {
      const response = await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
        method: "POST",
        body: JSON.stringify({ userId: `usr_${crypto.randomUUID()}`, role: "editor", displayName: `Member ${index}` }),
      });
      expect(response.status).toBe(201);
    }
    const ninth = await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: `usr_${crypto.randomUUID()}`, role: "editor", displayName: "Too many" }),
    });
    expect(ninth.status).toBe(409);
  });

  it("atomically admits only one direct member when two administrators race for the eighth slot", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    for (let index = 0; index < 6; index += 1) {
      expect((await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
        method: "POST",
        body: JSON.stringify({ userId: `usr_${crypto.randomUUID()}`, role: "editor", displayName: `Member ${index}` }),
      })).status).toBe(201);
    }
    const candidates = await Promise.all([0, 1].map((index) => request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: `usr_${crypto.randomUUID()}`, role: "editor", displayName: `Candidate ${index}` }),
    })));
    expect(candidates.map((response) => response.status).sort()).toEqual([201, 409]);
    const db = (env as unknown as TestEnv).DB;
    expect((await db.prepare(`SELECT COUNT(*) count FROM space_memberships WHERE space_id=? AND deleted_at IS NULL`)
      .bind(family.spaceId).first<{ count: number }>())?.count).toBe(8);
  });

  it("updates membership roles with optimistic concurrency", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const memberId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const added = await request(`/api/v1/spaces/${family.spaceId}/members`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ userId: memberId, role: "editor", displayName: "Member" }),
    });
    const member = await added.json<{ data: { version: number } }>();
    const promoted = await request(`/api/v1/spaces/${family.spaceId}/members/${memberId}`, family.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin", version: member.data.version }),
    });
    expect(promoted.status).toBe(200);
    expect((await promoted.json<{ data: { userId: string; role: string; version: number } }>()).data)
      .toMatchObject({ userId: memberId, role: "admin", version: member.data.version + 1 });
    const stale = await request(`/api/v1/spaces/${family.spaceId}/members/${memberId}`, family.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ role: "viewer", version: member.data.version }),
    });
    expect(stale.status).toBe(409);
  });

  it("reactivates the same membership and Space Person after removal", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const joiningId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const created = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ maxUses: 1, expiresInMinutes: 60 }),
    });
    const invitation = await created.json<{ data: { token: string } }>();
    const joiningToken = await token(privateKey, joiningId, ["spaces:read", "spaces:write"]);
    const first = await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token, displayName: "First name" }),
    });
    const firstJoin = await first.json<{ data: { personId: string } }>();
    const db = (env as unknown as TestEnv).DB;
    const firstMembership = await db.prepare("SELECT id FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
      .bind(family.spaceId, joiningId).first<{ id: string }>();
    expect((await request(`/api/v1/spaces/${family.spaceId}/members/${joiningId}`, family.accessToken, publicKey, { method: "DELETE" })).status).toBe(204);
    const secondCreated = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ maxUses: 1, expiresInMinutes: 60 }),
    });
    const secondInvitation = await secondCreated.json<{ data: { token: string } }>();
    const second = await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: secondInvitation.data.token, displayName: "Updated name" }),
    });
    expect(second.status).toBe(201);
    expect((await second.json<{ data: { personId: string } }>()).data.personId).toBe(firstJoin.data.personId);
    const secondMembership = await db.prepare("SELECT id FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
      .bind(family.spaceId, joiningId).first<{ id: string }>();
    expect(secondMembership?.id).toBe(firstMembership?.id);
    expect((await db.prepare("SELECT display_name FROM space_people WHERE id=?").bind(firstJoin.data.personId).first<{ display_name: string }>())?.display_name).toBe("Updated name");
  });

  it("returns a lifecycle conflict when a user leaves then replays the same live invite", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const joiningId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const created = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ maxUses: 2, expiresInMinutes: 60 }),
    });
    const invitation = await created.json<{ data: { token: string } }>();
    const joiningToken = await token(privateKey, joiningId, ["spaces:read", "spaces:write"]);
    expect((await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token, displayName: "Member" }),
    })).status).toBe(201);
    expect((await request(`/api/v1/spaces/${family.spaceId}/leave`, joiningToken, publicKey, { method: "POST" })).status).toBe(204);
    const replay = await request("/api/v1/space-invites/join", joiningToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ token: invitation.data.token, displayName: "Member again" }),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json<{ error: { code: string } }>()).error.code).toBe("INVITE_ALREADY_REDEEMED");
  });

  it("allows only one redemption when two users race for a one-use invite", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID()}`;
    const family = await createFamily(privateKey, publicKey, ownerId);
    const created = await request(`/api/v1/spaces/${family.spaceId}/invites`, family.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ maxUses: 1, expiresInMinutes: 60 }),
    });
    const invitation = await created.json<{ data: { token: string } }>();
    const candidates = await Promise.all([0, 1].map(async (index) => {
      const candidateToken = await token(privateKey, `usr_${crypto.randomUUID()}`, ["spaces:read", "spaces:write"]);
      return request("/api/v1/space-invites/join", candidateToken, publicKey, {
        method: "POST",
        body: JSON.stringify({ token: invitation.data.token, displayName: `Candidate ${index}` }),
      });
    }));
    expect(candidates.map((response) => response.status).sort()).toEqual([201, 409]);
  });
});
