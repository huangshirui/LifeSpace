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

async function token(
  privateKey: string,
  userId: string,
  clientId = "homemew-miniprogram",
  scopes = "spaces:read spaces:write spaces:manage wishes:read wishes:write",
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity", aud: "lifespace-core", sub: userId, azp: clientId,
    principal_type: "user", scope: scopes, iat, exp: iat + 900, jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    HOMEMEW_COMPAT_CLIENT_IDS: "homemew-miniprogram",
  });
}

async function mapUser(userId: string, displayName: string) {
  await (env as TestEnv).DB.prepare(`INSERT INTO legacy_homemew_user_maps(
    legacy_user_id,lifespace_user_id,display_name_snapshot,source_status,migrated_at) VALUES(?,?,?,'active',?)`)
    .bind(userId, userId, displayName, new Date().toISOString()).run();
}

async function createFamily(accessToken: string, publicKey: string) {
  const response = await request("/api/v1/families", accessToken, publicKey, {
    method: "POST", body: JSON.stringify({ name: "Home", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

async function joinMember(familyId: string, ownerToken: string, memberToken: string, publicKey: string) {
  const inviteResponse = await request(`/api/v1/families/${familyId}/invites`, ownerToken, publicKey, {
    method: "POST", body: JSON.stringify({ maxUses: 1, expiresInMinutes: 60 }),
  });
  const invite = await inviteResponse.json<{ data: { code: string } }>();
  expect((await request(`/api/v1/family-invites/${invite.data.code}/join`, memberToken, publicKey, { method: "POST" })).status).toBe(200);
}

async function createWish(familyId: string, accessToken: string, publicKey: string, input: Record<string, unknown>) {
  return request(`/api/v1/families/${familyId}/wishes`, accessToken, publicKey, {
    method: "POST", body: JSON.stringify(input),
  });
}

describe("Wishes and lifecycle", () => {
  it("stores one Space wish while preserving HomeMew owner and native Person shapes", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const familyId = await createFamily(accessToken, publicKey);

    const response = await createWish(familyId, accessToken, publicKey, {
      title: "New bicycle", description: "Blue", desiredDate: "2099-06-01",
    });
    expect(response.status).toBe(201);
    const wish = (await response.json<{ data: Record<string, any> }>()).data;
    expect(wish).toMatchObject({
      familyId, title: "New bicycle", description: "Blue", desiredDate: "2099-06-01", status: "open",
      owner: { userId: ownerId, displayName: "Owner", avatarUrl: null }, claimant: null, fulfilledBy: null, version: 1,
    });

    const persisted = await (env as TestEnv).DB.prepare(`SELECT w.space_id,w.owner_person_id,map.legacy_user_id
      FROM wishes w JOIN legacy_homemew_membership_maps map ON map.person_id=w.owner_person_id AND map.legacy_family_id=?
      WHERE w.id=?`).bind(familyId, wish.id).first<{ space_id: string; owner_person_id: string; legacy_user_id: string }>();
    expect(persisted?.space_id).toMatch(/^spc_/);
    expect(persisted?.owner_person_id).toMatch(/^per_/);
    expect(persisted?.legacy_user_id).toBe(ownerId);

    const native = await request(`/api/v1/spaces/${persisted?.space_id}/wishes/${wish.id}`, accessToken, publicKey);
    expect(native.status).toBe(200);
    expect((await native.json<{ data: Record<string, any> }>()).data).toMatchObject({
      spaceId: persisted?.space_id, owner: { personId: persisted?.owner_person_id, displayName: "Owner" }, status: "open",
    });
  });

  it("preserves claim, fulfill, reopen, archive and restore rules including removed claimant fallback", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);
    const wish = (await (await createWish(familyId, ownerToken, publicKey, { title: "Camping trip" })).json<{ data: Record<string, any> }>()).data;

    const ownClaim = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/claim`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 1 }),
    });
    expect(ownClaim.status).toBe(409);
    expect((await ownClaim.json<{ error: { code: string } }>()).error.code).toBe("WISH_CANNOT_CLAIM_OWN");

    const claimed = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/claim`, memberToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 1 }),
    });
    const claimedWish = (await claimed.json<{ data: Record<string, any> }>()).data;
    expect(claimedWish).toMatchObject({ status: "claimed", claimant: { userId: memberId, displayName: "Member" }, version: 2 });
    expect(claimedWish.claimedAt).toMatch(/Z$/);

    const fulfilled = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/fulfill`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    });
    expect((await fulfilled.json<{ data: Record<string, any> }>()).data).toMatchObject({
      status: "fulfilled", claimant: { userId: memberId }, fulfilledBy: { userId: ownerId }, version: 3,
    });

    const reopened = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/reopen`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 3 }),
    });
    expect((await reopened.json<{ data: Record<string, any> }>()).data).toMatchObject({
      status: "open", claimant: null, claimedAt: null, fulfilledBy: null, fulfilledAt: null, version: 4,
    });

    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}/claim`, memberToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 4 }),
    })).status).toBe(200);
    const archived = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/archive`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 5 }),
    });
    expect((await archived.json<{ data: Record<string, any> }>()).data).toMatchObject({
      status: "archived", claimant: { userId: memberId }, version: 6,
    });

    const archivedEdit = await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 6, title: "No edit" }),
    });
    expect(archivedEdit.status).toBe(409);
    expect((await archivedEdit.json<{ error: { code: string } }>()).error.code).toBe("WISH_ARCHIVED");

    const membership = await (env as TestEnv).DB.prepare(`SELECT membership_id,person_id FROM legacy_homemew_membership_maps
      WHERE legacy_family_id=? AND legacy_user_id=?`).bind(familyId, memberId).first<{ membership_id: string; person_id: string }>();
    const removedAt = new Date().toISOString();
    await (env as TestEnv).DB.batch([
      (env as TestEnv).DB.prepare("UPDATE space_memberships SET deleted_at=?,updated_at=? WHERE id=?").bind(removedAt, removedAt, membership?.membership_id),
      (env as TestEnv).DB.prepare("UPDATE space_people SET deleted_at=?,updated_at=? WHERE id=?").bind(removedAt, removedAt, membership?.person_id),
    ]);

    const historical = await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, ownerToken, publicKey);
    expect((await historical.json<{ data: Record<string, any> }>()).data.claimant).toMatchObject({ userId: memberId, displayName: "Member" });

    const restored = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/restore`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 6 }),
    });
    expect((await restored.json<{ data: Record<string, any> }>()).data).toMatchObject({
      status: "open", claimant: null, claimedAt: null, version: 7,
    });
  });

  it("enforces owner/claimant actions, optimistic versions and soft deletion", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);
    const wish = (await (await createWish(familyId, ownerToken, publicKey, { title: "Concert" })).json<{ data: Record<string, any> }>()).data;

    const memberEdit = await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, memberToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 1, title: "Hijack" }),
    });
    expect(memberEdit.status).toBe(403);
    expect((await memberEdit.json<{ error: { code: string } }>()).error.code).toBe("WISH_OWNER_REQUIRED");

    const stale = await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 99, title: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("VERSION_CONFLICT");

    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}/claim`, memberToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 1 }),
    })).status).toBe(200);
    const ownerUnclaim = await request(`/api/v1/families/${familyId}/wishes/${wish.id}/unclaim`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    });
    expect(ownerUnclaim.status).toBe(403);
    expect((await ownerUnclaim.json<{ error: { code: string } }>()).error.code).toBe("WISH_CLAIMANT_REQUIRED");
    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}/unclaim`, memberToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    })).status).toBe(200);

    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}?version=3`, ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, ownerToken, publicKey)).status).toBe(404);
  });

  it("filters and paginates owner/claimant/date/status while binding cursors", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);

    const firstWish = (await (await createWish(familyId, ownerToken, publicKey, { title: "A", desiredDate: "2099-01-01" })).json<{ data: Record<string, any> }>()).data;
    await createWish(familyId, ownerToken, publicKey, { title: "B", desiredDate: "2099-02-01" });
    await createWish(familyId, ownerToken, publicKey, { title: "C" });
    expect((await request(`/api/v1/families/${familyId}/wishes/${firstWish.id}/claim`, memberToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 1 }),
    })).status).toBe(200);

    const claimed = await request(`/api/v1/families/${familyId}/wishes?status=claimed&claimantUserId=me&desiredFrom=2099-01-01&desiredTo=2099-12-31`, memberToken, publicKey);
    const claimedPage = await claimed.json<{ data: { items: Array<Record<string, any>> } }>();
    expect(claimedPage.data.items).toHaveLength(1);
    expect(claimedPage.data.items[0]).toMatchObject({ id: firstWish.id, claimant: { userId: memberId } });

    const query = `ownerUserId=${ownerId}&sort=desired_asc&limit=2`;
    const first = await request(`/api/v1/families/${familyId}/wishes?${query}`, ownerToken, publicKey);
    const page = await first.json<{ data: { items: Array<{ title: string }>; nextCursor: string } }>();
    expect(page.data.items.map((item) => item.title)).toEqual(["A", "B"]);
    expect(page.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/families/${familyId}/wishes?${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ title: string }> } }>()).data.items.map((item) => item.title)).toEqual(["C"]);
    expect((await request(`/api/v1/families/${familyId}/wishes?status=open&${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, ownerToken, publicKey)).status).toBe(400);
  });

  it("enforces wishes scopes, HomeMew compatibility allowlist and Space isolation", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const outsiderId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(outsiderId, "Outsider");
    const ownerToken = await token(privateKey, ownerId), outsiderToken = await token(privateKey, outsiderId);
    const familyId = await createFamily(ownerToken, publicKey);
    const wish = (await (await createWish(familyId, ownerToken, publicKey, { title: "Private" })).json<{ data: { id: string } }>()).data;

    expect((await request(`/api/v1/families/${familyId}/wishes/${wish.id}`, outsiderToken, publicKey)).status).toBe(403);
    const missingScope = await token(privateKey, ownerId, "homemew-miniprogram", "spaces:read");
    expect((await request(`/api/v1/families/${familyId}/wishes`, missingScope, publicKey)).status).toBe(403);
    const wrongClient = await token(privateKey, ownerId, "other-client");
    expect((await request(`/api/v1/families/${familyId}/wishes`, wrongClient, publicKey)).status).toBe(403);
  });
});
