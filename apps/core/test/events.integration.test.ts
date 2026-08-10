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

async function token(privateKey: string, userId: string, clientId = "homemew-miniprogram", scopes = "spaces:read spaces:write spaces:manage events:read events:write") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: scopes,
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
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: db,
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
    method: "POST",
    body: JSON.stringify({ name: "Home", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

async function joinMember(familyId: string, ownerToken: string, memberToken: string, publicKey: string) {
  const inviteResponse = await request(`/api/v1/families/${familyId}/invites`, ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ maxUses: 1, expiresInMinutes: 60 }),
  });
  const invite = await inviteResponse.json<{ data: { code: string } }>();
  const joined = await request(`/api/v1/family-invites/${invite.data.code}/join`, memberToken, publicKey, { method: "POST" });
  expect(joined.status).toBe(200);
}

describe("Events and attendees", () => {
  it("stores one native Space event while preserving the HomeMew event and attendee contract", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId);
    const memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);

    const created = await request(`/api/v1/families/${familyId}/events`, ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        summary: "Training",
        description: "Bring boots",
        location: "Pitch",
        isAllDay: false,
        startAt: "2026-08-12T10:00:00Z",
        endAt: "2026-08-12T12:00:00Z",
        attendeeIds: [memberId],
      }),
    });
    expect(created.status).toBe(201);
    const event = (await created.json<{ data: Record<string, unknown> }>()).data;
    expect(event).toMatchObject({
      familyId,
      summary: "Training",
      startAt: "2026-08-12T10:00:00.000Z",
      startTimezone: "Asia/Shanghai",
      attendees: [{ userId: memberId, displayName: "Member", avatarUrl: null }],
      createdBy: { type: "user", id: ownerId, name: "Owner", avatarUrl: null },
      version: 1,
    });

    const db = (env as TestEnv).DB;
    const persisted = await db.prepare(`SELECT e.space_id,ea.person_id,map.legacy_user_id
      FROM events e JOIN event_attendees ea ON ea.event_id=e.id
      JOIN legacy_homemew_membership_maps map ON map.person_id=ea.person_id
      WHERE e.id=?`).bind(event.id).first<{ space_id: string; person_id: string; legacy_user_id: string }>();
    expect(persisted?.space_id).toMatch(/^spc_/);
    expect(persisted?.person_id).toMatch(/^per_/);
    expect(persisted?.legacy_user_id).toBe(memberId);

    const native = await request(`/api/v1/spaces/${persisted?.space_id}/events/${event.id}`, ownerToken, publicKey);
    expect((await native.json<{ data: Record<string, unknown> }>()).data).toMatchObject({
      spaceId: persisted?.space_id,
      attendees: [{ personId: persisted?.person_id, displayName: "Member" }],
    });
  });

  it("lists timed and all-day overlap windows with search, attendee filters and bound cursors", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const familyId = await createFamily(accessToken, publicKey);
    const payloads = [
      { summary: "Alpha football", isAllDay: false, startAt: "2026-08-10T16:00:00Z", endAt: "2026-08-10T17:00:00Z", attendeeIds: [ownerId] },
      { summary: "Beta holiday", description: "football break", isAllDay: true, startDate: "2026-08-11", endDateExclusive: "2026-08-13", attendeeIds: [ownerId] },
      { summary: "Outside", isAllDay: true, startDate: "2026-09-01", endDateExclusive: "2026-09-02" },
    ];
    for (const payload of payloads) {
      expect((await request(`/api/v1/families/${familyId}/events`, accessToken, publicKey, {
        method: "POST", body: JSON.stringify(payload),
      })).status).toBe(201);
    }
    const first = await request(`/api/v1/families/${familyId}/events?startDate=2026-08-10&endDateExclusive=2026-08-14&q=football&attendeeId=me&limit=1`, accessToken, publicKey);
    expect(first.status).toBe(200);
    const page = await first.json<{ data: { items: Array<{ summary: string }>; nextCursor: string } }>();
    expect(page.data.items).toHaveLength(1);
    expect(page.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/families/${familyId}/events?startDate=2026-08-10&endDateExclusive=2026-08-14&q=football&attendeeId=me&limit=1&cursor=${encodeURIComponent(page.data.nextCursor)}`, accessToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ summary: string }>; nextCursor: null } }>()).data.items).toHaveLength(1);
    const mismatched = await request(`/api/v1/families/${familyId}/events?startDate=2026-08-10&endDateExclusive=2026-08-15&q=football&attendeeId=me&limit=1&cursor=${encodeURIComponent(page.data.nextCursor)}`, accessToken, publicKey);
    expect(mismatched.status).toBe(400);
  });

  it("updates time type and attendees atomically and rejects stale versions", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId);
    const memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);
    const created = await request(`/api/v1/families/${familyId}/events`, ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ summary: "Timed", isAllDay: false, startAt: "2026-08-20T10:00:00Z", endAt: "2026-08-20T11:00:00Z", attendeeIds: [ownerId] }),
    });
    const event = (await created.json<{ data: { id: string } }>()).data;
    const updated = await request(`/api/v1/families/${familyId}/events/${event.id}`, ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, isAllDay: true, startDate: "2026-08-21", endDateExclusive: "2026-08-22", attendeeIds: [memberId] }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: Record<string, unknown> }>()).data).toMatchObject({
      isAllDay: true,
      startDate: "2026-08-21",
      attendees: [{ userId: memberId }],
      version: 2,
    });
    const stale = await request(`/api/v1/families/${familyId}/events/${event.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 1, summary: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("enforces app scope, Space permission, compatibility allowlist and cross-Space isolation", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const outsiderId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    await mapUser(outsiderId, "Outsider");
    const ownerToken = await token(privateKey, ownerId);
    const outsiderToken = await token(privateKey, outsiderId);
    const familyId = await createFamily(ownerToken, publicKey);
    const created = await request(`/api/v1/families/${familyId}/events`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ summary: "Private", isAllDay: true, startDate: "2026-08-20", endDateExclusive: "2026-08-21" }),
    });
    const eventId = (await created.json<{ data: { id: string } }>()).data.id;
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}`, outsiderToken, publicKey)).status).toBe(403);
    const noScope = await token(privateKey, ownerId, "homemew-miniprogram", "spaces:read spaces:write spaces:manage");
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}`, noScope, publicKey)).status).toBe(403);
    const otherClient = await token(privateKey, ownerId, "aloha-web");
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}`, otherClient, publicKey)).status).toBe(403);
  });

  it("soft-deletes with optimistic concurrency and excludes the event from reads", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const familyId = await createFamily(accessToken, publicKey);
    const created = await request(`/api/v1/families/${familyId}/events`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ summary: "Delete me", isAllDay: true, startDate: "2026-08-20", endDateExclusive: "2026-08-21" }),
    });
    const eventId = (await created.json<{ data: { id: string } }>()).data.id;
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}?version=99`, accessToken, publicKey, { method: "DELETE" })).status).toBe(409);
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}?version=1`, accessToken, publicKey, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/v1/families/${familyId}/events/${eventId}`, accessToken, publicKey)).status).toBe(404);
    const stored = await (env as TestEnv).DB.prepare("SELECT deleted_at,deleted_by_id,version FROM events WHERE id=?")
      .bind(eventId).first<{ deleted_at: string; deleted_by_id: string; version: number }>();
    expect(stored).toMatchObject({ deleted_by_id: ownerId, version: 2 });
    expect(stored?.deleted_at).toMatch(/Z$/);
  });
});
