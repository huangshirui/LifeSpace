import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { addDateDays, spaceToday } from "../src/day-calculation";
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

async function token(privateKey: string, userId: string, clientId = "homemew-miniprogram", scopes = "spaces:read spaces:write spaces:manage day-records:read day-records:write") {
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

async function createDay(familyId: string, accessToken: string, publicKey: string, input: Record<string, unknown>) {
  return request(`/api/v1/families/${familyId}/day-records`, accessToken, publicKey, {
    method: "POST", body: JSON.stringify(input),
  });
}

const today = () => spaceToday("Asia/Shanghai");

describe("Day records and occurrence history", () => {
  it("stores one Space domain while preserving HomeMew kinds, defaults and subject shape", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const familyId = await createFamily(accessToken, publicKey);
    const current = today();

    const elapsedResponse = await createDay(familyId, accessToken, publicKey, {
      name: "Haircut", kind: "elapsed", anchorDate: current, subjectUserId: ownerId,
    });
    expect(elapsedResponse.status).toBe(201);
    const elapsed = (await elapsedResponse.json<{ data: Record<string, any> }>()).data;
    expect(elapsed).toMatchObject({
      familyId, kind: "elapsed", anchorDate: current, attentionAfterDays: null,
      subject: { userId: ownerId, displayName: "Owner", avatarUrl: null }, status: "active", version: 1,
      computed: { today: current, elapsedDays: 0, remainingDays: null, state: "normal" },
    });

    const countdown = (await (await createDay(familyId, accessToken, publicKey, {
      name: "Trip", kind: "countdown", anchorDate: current,
    })).json<{ data: Record<string, any> }>()).data;
    expect(countdown).toMatchObject({ kind: "countdown", attentionBeforeDays: 30, computed: { remainingDays: 0, state: "today" } });

    const cycleAnchor = addDateDays(current, -10);
    const cycle = (await (await createDay(familyId, accessToken, publicKey, {
      name: "Filter", kind: "cycle", anchorDate: cycleAnchor, cycleDays: 10,
    })).json<{ data: Record<string, any> }>()).data;
    expect(cycle).toMatchObject({
      kind: "cycle", attentionBeforeDays: 7, nextDueDate: current,
      computed: { elapsedDays: 10, remainingDays: 0, progressRatio: 1, state: "due", attentionLevel: "critical" },
    });

    const persisted = await (env as TestEnv).DB.prepare(`SELECT d.space_id,d.subject_person_id,map.legacy_user_id
      FROM day_records d LEFT JOIN legacy_homemew_membership_maps map ON map.person_id=d.subject_person_id AND map.legacy_family_id=?
      WHERE d.id=?`).bind(familyId, elapsed.id).first<{ space_id: string; subject_person_id: string; legacy_user_id: string }>();
    expect(persisted?.space_id).toMatch(/^spc_/);
    expect(persisted?.subject_person_id).toMatch(/^per_/);
    expect(persisted?.legacy_user_id).toBe(ownerId);

    const native = await request(`/api/v1/spaces/${persisted?.space_id}/day-records/${elapsed.id}`, accessToken, publicKey);
    expect((await native.json<{ data: Record<string, any> }>()).data).toMatchObject({
      spaceId: persisted?.space_id, subject: { personId: persisted?.subject_person_id, displayName: "Owner" },
    });

    const history = await request(`/api/v1/families/${familyId}/day-records/${elapsed.id}/occurrences`, accessToken, publicKey);
    expect((await history.json<{ data: Record<string, any> }>()).data).toMatchObject({
      items: [{ occurredOn: current, source: "initial", intervalDays: null }], nextCursor: null,
    });
    const countdownHistory = await request(`/api/v1/families/${familyId}/day-records/${countdown.id}/occurrences`, accessToken, publicKey);
    expect((await countdownHistory.json<{ data: { items: unknown[] } }>()).data.items).toEqual([]);
  });

  it("records forward occurrences atomically and enforces archive/version/delete lifecycle", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId);
    const familyId = await createFamily(accessToken, publicKey);
    const current = today();
    const anchor = addDateDays(current, -3);
    const record = (await (await createDay(familyId, accessToken, publicKey, {
      name: "Car wash", kind: "cycle", anchorDate: anchor, cycleDays: 30,
    })).json<{ data: Record<string, any> }>()).data;

    const occurrence = await request(`/api/v1/families/${familyId}/day-records/${record.id}/occurrences`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ occurredOn: current, note: "Hand wash", version: 1 }),
    });
    expect(occurrence.status).toBe(201);
    expect((await occurrence.json<{ data: Record<string, any> }>()).data).toMatchObject({
      previousAnchorDate: anchor, intervalDays: 3,
      record: { anchorDate: current, nextDueDate: addDateDays(current, 30), version: 2 },
    });

    const duplicate = await request(`/api/v1/families/${familyId}/day-records/${record.id}/occurrences`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ occurredOn: current, version: 2 }),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json<{ error: { code: string } }>()).error.code).toBe("DUPLICATE_DAY_OCCURRENCE");

    const stale = await request(`/api/v1/families/${familyId}/day-records/${record.id}`, accessToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 1, name: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("DAY_RECORD_VERSION_CONFLICT");

    const archived = await request(`/api/v1/families/${familyId}/day-records/${record.id}/archive`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    });
    expect((await archived.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ status: "archived", version: 3 });
    const editArchived = await request(`/api/v1/families/${familyId}/day-records/${record.id}`, accessToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 3, name: "No" }),
    });
    expect((await editArchived.json<{ error: { code: string } }>()).error.code).toBe("DAY_RECORD_ARCHIVED");
    const archivedOccurrence = await request(`/api/v1/families/${familyId}/day-records/${record.id}/occurrences`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ occurredOn: current, version: 3 }),
    });
    expect((await archivedOccurrence.json<{ error: { code: string } }>()).error.code).toBe("DAY_RECORD_ARCHIVED");

    const restored = await request(`/api/v1/families/${familyId}/day-records/${record.id}/restore`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 3 }),
    });
    expect((await restored.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ status: "active", version: 4 });
    expect((await request(`/api/v1/families/${familyId}/day-records/${record.id}?version=4`, accessToken, publicKey, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/v1/families/${familyId}/day-records/${record.id}`, accessToken, publicKey)).status).toBe(404);
  });

  it("sorts attention, filters subjects, binds cursors and preserves historical removed subjects", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Former member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);
    const current = today();

    for (const input of [
      { name: "Critical", kind: "countdown", anchorDate: addDateDays(current, -1), subjectUserId: memberId },
      { name: "Warning", kind: "cycle", anchorDate: addDateDays(current, -9), cycleDays: 10, attentionBeforeDays: 2 },
      { name: "Info", kind: "countdown", anchorDate: addDateDays(current, 5), attentionBeforeDays: 7 },
      { name: "None", kind: "elapsed", anchorDate: current },
    ]) expect((await createDay(familyId, ownerToken, publicKey, input)).status).toBe(201);

    const query = "status=active&attentionOnly=true&sort=attention&limit=2";
    const first = await request(`/api/v1/families/${familyId}/day-records?${query}`, ownerToken, publicKey);
    const page = await first.json<{ data: { items: Array<{ name: string }>; nextCursor: string } }>();
    expect(page.data.items.map((item) => item.name)).toEqual(["Critical", "Warning"]);
    const second = await request(`/api/v1/families/${familyId}/day-records?${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ name: string }> } }>()).data.items.map((item) => item.name)).toEqual(["Info"]);
    expect((await request(`/api/v1/families/${familyId}/day-records?kind=countdown&${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, ownerToken, publicKey)).status).toBe(400);

    const mine = await request(`/api/v1/families/${familyId}/day-records?subjectUserId=${memberId}&sort=created_desc`, ownerToken, publicKey);
    const subjectRecord = (await mine.json<{ data: { items: Array<Record<string, any>> } }>()).data.items[0];
    expect(subjectRecord).toMatchObject({ name: "Critical", subject: { userId: memberId, displayName: "Former member" } });

    const membership = await (env as TestEnv).DB.prepare(`SELECT membership_id,person_id FROM legacy_homemew_membership_maps
      WHERE legacy_family_id=? AND legacy_user_id=?`).bind(familyId, memberId).first<{ membership_id: string; person_id: string }>();
    const removedAt = new Date().toISOString();
    await (env as TestEnv).DB.batch([
      (env as TestEnv).DB.prepare("UPDATE space_memberships SET deleted_at=?,updated_at=? WHERE id=?").bind(removedAt, removedAt, membership?.membership_id),
      (env as TestEnv).DB.prepare("UPDATE space_people SET deleted_at=?,updated_at=? WHERE id=?").bind(removedAt, removedAt, membership?.person_id),
    ]);
    const historical = await request(`/api/v1/families/${familyId}/day-records/${subjectRecord.id}`, ownerToken, publicKey);
    expect((await historical.json<{ data: Record<string, any> }>()).data.subject).toMatchObject({ userId: memberId, displayName: "Former member" });
  });

  it("enforces scopes, compatibility allowlist and cross-Space subject isolation", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const outsiderId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(outsiderId, "Outsider");
    const ownerToken = await token(privateKey, ownerId), outsiderToken = await token(privateKey, outsiderId);
    const familyId = await createFamily(ownerToken, publicKey);
    const record = (await (await createDay(familyId, ownerToken, publicKey, {
      name: "Private", kind: "countdown", anchorDate: today(),
    })).json<{ data: { id: string } }>()).data;
    expect((await request(`/api/v1/families/${familyId}/day-records/${record.id}`, outsiderToken, publicKey)).status).toBe(403);

    const noScope = await token(privateKey, ownerId, "homemew-miniprogram", "spaces:read spaces:write spaces:manage");
    expect((await request(`/api/v1/families/${familyId}/day-records/${record.id}`, noScope, publicKey)).status).toBe(403);
    const otherClient = await token(privateKey, ownerId, "aloha-web");
    expect((await request(`/api/v1/families/${familyId}/day-records/${record.id}`, otherClient, publicKey)).status).toBe(403);

    const secondFamily = await createFamily(ownerToken, publicKey);
    const firstSpace = await (env as TestEnv).DB.prepare("SELECT space_id FROM legacy_homemew_family_maps WHERE legacy_family_id=?")
      .bind(familyId).first<{ space_id: string }>();
    const foreignPerson = await (env as TestEnv).DB.prepare("SELECT person_id FROM legacy_homemew_membership_maps WHERE legacy_family_id=? AND legacy_user_id=?")
      .bind(secondFamily, ownerId).first<{ person_id: string }>();
    const invalid = await request(`/api/v1/spaces/${firstSpace?.space_id}/day-records`, ownerToken, publicKey, {
      method: "POST", body: JSON.stringify({ name: "Invalid", kind: "countdown", anchorDate: today(), subjectPersonId: foreignPerson?.person_id }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<{ error: { code: string } }>()).error.code).toBe("INVALID_DAY_RECORD_SUBJECT");
  });
});
