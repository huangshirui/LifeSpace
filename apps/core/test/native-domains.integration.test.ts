import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { addDateDays, spaceToday } from "../src/day-calculation";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

type Family = {
  spaceId: string;
  ownerId: string;
  ownerPersonId: string;
  ownerToken: string;
};

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

const scopes = [
  "profile:read",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "events:read",
  "events:write",
  "tasks:read",
  "tasks:write",
  "day-records:read",
  "day-records:write",
  "wishes:read",
  "wishes:write",
];

async function token(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "homemew-miniprogram",
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
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function createFamily(privateKey: string, publicKey: string, label = "Home"): Promise<Family> {
  const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const ownerToken = await token(privateKey, ownerId);
  const response = await request("/api/v1/spaces", ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: label, ownerDisplayName: `${label} owner`, timezone: "UTC" }),
  });
  expect(response.status).toBe(201);
  const data = (await response.json<{ data: { id: string } }>()).data;
  const person = await (env as unknown as TestEnv).DB.prepare(
    "SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL",
  ).bind(data.id, ownerId).first<{ id: string }>();
  expect(person?.id).toMatch(/^per_/);
  return { spaceId: data.id, ownerId, ownerPersonId: person!.id, ownerToken };
}

async function addMember(family: Family, privateKey: string, publicKey: string, displayName = "Member") {
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await request(`/api/v1/spaces/${family.spaceId}/members`, family.ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ userId, role: "editor", displayName }),
  });
  expect(response.status).toBe(201);
  const person = await (env as unknown as TestEnv).DB.prepare(
    "SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL",
  ).bind(family.spaceId, userId).first<{ id: string }>();
  expect(person?.id).toMatch(/^per_/);
  return { userId, personId: person!.id, accessToken: await token(privateKey, userId) };
}

describe("native-only Space domain API", () => {
  it("does not expose the retired HomeMew family runtime facade", async () => {
    const { privateKey, publicKey } = await keys();
    const accessToken = await token(privateKey, `usr_${crypto.randomUUID().replaceAll("-", "")}`);
    expect((await request("/api/v1/families", accessToken, publicKey)).status).toBe(404);
    expect((await request("/api/v1/me/families", accessToken, publicKey)).status).toBe(404);
    expect((await request("/api/v1/family-invites/legacy", accessToken, publicKey)).status).toBe(404);
  });

  it("runs native event lifecycle with Space Person attendees and isolation", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);
    const other = await createFamily(privateKey, publicKey, "Other");

    const crossSpace = await request(`/api/v1/spaces/${family.spaceId}/events`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        summary: "Invalid",
        isAllDay: true,
        startDate: "2026-08-11",
        endDateExclusive: "2026-08-12",
        attendeePersonIds: [other.ownerPersonId],
      }),
    });
    expect(crossSpace.status).toBe(400);

    const created = await request(`/api/v1/spaces/${family.spaceId}/events`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        summary: "Training",
        description: "Bring boots",
        location: "Pitch",
        isAllDay: false,
        startAt: "2026-08-12T10:00:00Z",
        endAt: "2026-08-12T12:00:00Z",
        attendeePersonIds: [member.personId],
      }),
    });
    expect(created.status).toBe(201);
    const event = (await created.json<{ data: { id: string; spaceId: string; attendees: Array<{ personId: string }>; version: number } }>()).data;
    expect(event).toMatchObject({ spaceId: family.spaceId, attendees: [{ personId: member.personId }], version: 1 });

    const listed = await request(
      `/api/v1/spaces/${family.spaceId}/events?startDate=2026-08-12&endDateExclusive=2026-08-13&attendeePersonId=${member.personId}`,
      family.ownerToken,
      publicKey,
    );
    expect((await listed.json<{ data: { items: Array<{ id: string }> } }>()).data.items.map((item) => item.id)).toContain(event.id);

    const updated = await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, isAllDay: true, startDate: "2026-08-13", endDateExclusive: "2026-08-14", attendeePersonIds: [family.ownerPersonId] }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: { isAllDay: boolean; attendees: Array<{ personId: string }>; version: number } }>()).data)
      .toMatchObject({ isAllDay: true, attendees: [{ personId: family.ownerPersonId }], version: 2 });

    const stale = await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, summary: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}?version=2`, family.ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
  });

  it("runs native task lifecycle with assignees, filters and optimistic concurrency", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);

    const created = await request(`/api/v1/spaces/${family.spaceId}/tasks`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: "Pack kit", dueDate: "2026-08-15", assigneePersonIds: [member.personId] }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json<{ data: { id: string; spaceId: string; assignees: Array<{ personId: string }>; version: number } }>()).data;
    expect(task).toMatchObject({ spaceId: family.spaceId, assignees: [{ personId: member.personId }], version: 1 });

    const listed = await request(`/api/v1/spaces/${family.spaceId}/tasks?assigneePersonId=${member.personId}&dueDateFrom=2026-08-14&dueDateTo=2026-08-16`, family.ownerToken, publicKey);
    expect((await listed.json<{ data: { items: Array<{ id: string }> } }>()).data.items.map((item) => item.id)).toContain(task.id);

    const completed = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/complete`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(completed.status).toBe(200);
    expect((await completed.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "completed", version: 2 });

    const stale = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/reopen`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(stale.status).toBe(409);
    const reopened = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/reopen`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect((await reopened.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "pending", version: 3 });
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}?version=3`, family.ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
  });

  it("preserves native day-record occurrence and archive semantics", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);
    const today = spaceToday("UTC");
    const anchor = addDateDays(today, -10);
    const occurrence = addDateDays(today, -5);

    const created = await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        name: "Filter service",
        kind: "cycle",
        anchorDate: anchor,
        cycleDays: 30,
        attentionBeforeDays: 7,
        subjectPersonId: member.personId,
      }),
    });
    expect(created.status).toBe(201);
    const record = (await created.json<{ data: { id: string; subject: { personId: string }; version: number } }>()).data;
    expect(record).toMatchObject({ subject: { personId: member.personId }, version: 1 });

    const advanced = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/occurrences`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ occurredOn: occurrence, note: "Done", version: 1 }),
    });
    expect(advanced.status).toBe(201);
    const advancedData = (await advanced.json<{ data: { record: { anchorDate: string; version: number }; intervalDays: number } }>()).data;
    expect(advancedData.record).toMatchObject({ anchorDate: occurrence, version: 2 });
    expect(advancedData.intervalDays).toBe(5);

    const history = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/occurrences`, family.ownerToken, publicKey);
    expect((await history.json<{ data: { items: Array<{ source: string }> } }>()).data.items.map((item) => item.source).sort()).toEqual(["initial", "manual"]);

    const archived = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/archive`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect((await archived.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "archived", version: 3 });
    const blocked = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ name: "Blocked", version: 3 }),
    });
    expect(blocked.status).toBe(409);
    const restored = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/restore`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    });
    expect((await restored.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "active", version: 4 });
  });

  it("runs native wish ownership, claim, fulfillment and archive lifecycle", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);

    const created = await request(`/api/v1/spaces/${family.spaceId}/wishes`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ title: "New boots", desiredDate: "2026-09-01" }),
    });
    expect(created.status).toBe(201);
    const wish = (await created.json<{ data: { id: string; owner: { personId: string }; version: number } }>()).data;
    expect(wish).toMatchObject({ owner: { personId: family.ownerPersonId }, version: 1 });

    const ownClaim = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/claim`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(ownClaim.status).toBe(409);

    const claimed = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/claim`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect((await claimed.json<{ data: { status: string; claimant: { personId: string }; version: number } }>()).data)
      .toMatchObject({ status: "claimed", claimant: { personId: member.personId }, version: 2 });

    const fulfilled = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/fulfill`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect((await fulfilled.json<{ data: { status: string; fulfilledBy: { personId: string }; version: number } }>()).data)
      .toMatchObject({ status: "fulfilled", fulfilledBy: { personId: member.personId }, version: 3 });

    const reopened = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/reopen`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    });
    expect((await reopened.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "open", version: 4 });

    const archived = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/archive`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 4 }),
    });
    expect((await archived.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "archived", version: 5 });
    const restored = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/restore`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 5 }),
    });
    expect((await restored.json<{ data: { status: string; version: number } }>()).data).toMatchObject({ status: "open", version: 6 });
    expect((await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}?version=6`, family.ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
  });
});
