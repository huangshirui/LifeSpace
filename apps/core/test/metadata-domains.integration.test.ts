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
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

const scopes = [
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "resources:read",
  "resources:write",
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

async function createFamily(
  privateKey: string,
  publicKey: string,
  label = "Home",
  timezone = "UTC",
): Promise<Family> {
  const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const ownerToken = await token(privateKey, ownerId);
  const response = await request("/api/v1/spaces", ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({
      kind: "family",
      name: label,
      ownerDisplayName: `${label} owner`,
      timezone,
    }),
  });
  expect(response.status).toBe(201);
  const data = (await response.json<{ data: { id: string; ownerPersonId?: string } }>()).data;
  const ownerPersonId = data.ownerPersonId ?? (await (env as unknown as TestEnv).DB.prepare(
    "SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL",
  ).bind(data.id, ownerId).first<{ id: string }>())?.id;
  expect(ownerPersonId).toMatch(/^per_/);
  return { spaceId: data.id, ownerId, ownerPersonId: ownerPersonId!, ownerToken };
}

async function addMember(
  family: Family,
  privateKey: string,
  publicKey: string,
  displayName = "Member",
) {
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

async function data<T>(response: Response): Promise<T> {
  const payload = await response.json<{ data: T }>();
  return payload.data;
}

describe("metadata-driven built-in domains", () => {
  it("keeps the retired HomeMew family facade absent", async () => {
    const { privateKey, publicKey } = await keys();
    const accessToken = await token(privateKey, `usr_${crypto.randomUUID().replaceAll("-", "")}`);
    expect((await request("/api/v1/families", accessToken, publicKey)).status).toBe(404);
    expect((await request("/api/v1/me/families", accessToken, publicKey)).status).toBe(404);
    expect((await request("/api/v1/family-invites/legacy", accessToken, publicKey)).status).toBe(404);
  });

  it("runs Event through Generic Runtime + Calendar capability", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);
    const other = await createFamily(privateKey, publicKey, "Other");

    const crossSpace = await request(`/api/v1/spaces/${family.spaceId}/events`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        summary: "Invalid attendee",
        isAllDay: true,
        startDate: "2026-08-12",
        endDateExclusive: "2026-08-13",
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
        startTimezone: "Asia/Shanghai",
        endTimezone: "Asia/Shanghai",
        attendeePersonIds: [member.personId],
      }),
    });
    expect(created.status).toBe(201);
    const event = await data<{
      id: string;
      modelKey: string;
      modelVersion: number;
      status: string;
      attendeePersonIds: string[];
      version: number;
    }>(created);
    expect(event).toMatchObject({
      modelKey: "event",
      modelVersion: 2,
      status: "active",
      attendeePersonIds: [member.personId],
      version: 1,
    });

    const listed = await request(
      `/api/v1/spaces/${family.spaceId}/events?rangeStart=2026-08-12T09:00:00Z&rangeEnd=2026-08-12T11:00:00Z&attendeePersonIds=${member.personId}&sort=calendarStart:asc`,
      family.ownerToken,
      publicKey,
    );
    expect((await data<{ items: Array<{ id: string }> }>(listed)).items.map((item) => item.id)).toContain(event.id);

    const updated = await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({
        version: 1,
        isAllDay: true,
        startAt: null,
        endAt: null,
        startTimezone: null,
        endTimezone: null,
        startDate: "2026-08-13",
        endDateExclusive: "2026-08-14",
      }),
    });
    expect(updated.status).toBe(200);
    expect(await data<{ isAllDay: boolean; startDate: string; version: number }>(updated))
      .toMatchObject({ isAllDay: true, startDate: "2026-08-13", version: 2 });

    const stale = await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, summary: "Stale" }),
    });
    expect(stale.status).toBe(409);

    expect((await request(`/api/v1/spaces/${family.spaceId}/events/${event.id}`, family.ownerToken, publicKey, {
      method: "DELETE",
      body: JSON.stringify({ version: 2 }),
    })).status).toBe(204);
  });

  it("runs Task through Generic Runtime + Workflow defaults/actions", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);

    const created = await request(`/api/v1/spaces/${family.spaceId}/tasks`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        name: "Pack kit",
        dueDate: "2026-08-15",
        assigneePersonIds: [member.personId],
      }),
    });
    expect(created.status).toBe(201);
    const task = await data<{
      id: string;
      modelKey: string;
      modelVersion: number;
      status: string;
      assigneePersonIds: string[];
      version: number;
    }>(created);
    expect(task).toMatchObject({
      modelKey: "task",
      modelVersion: 2,
      status: "pending",
      assigneePersonIds: [member.personId],
      version: 1,
    });

    const listed = await request(
      `/api/v1/spaces/${family.spaceId}/tasks?assigneePersonIds=${member.personId}&dueDateFrom=2026-08-14&dueDateTo=2026-08-16`,
      family.ownerToken,
      publicKey,
    );
    expect((await data<{ items: Array<{ id: string }> }>(listed)).items.map((item) => item.id)).toContain(task.id);

    const completed = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/actions/complete`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(completed.status).toBe(200);
    expect(await data<{ status: string; completedByType: string; completedById: string; version: number }>(completed))
      .toMatchObject({ status: "completed", completedByType: "user", completedById: member.userId, version: 2 });

    const stale = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/actions/reopen`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(stale.status).toBe(409);

    const reopened = await request(`/api/v1/spaces/${family.spaceId}/tasks/${task.id}/actions/reopen`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(await data<{ status: string; version: number }>(reopened)).toMatchObject({ status: "pending", version: 3 });
  });

  it("runs Day Record through Generic Runtime + Temporal capability", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey, "Temporal", "Asia/Shanghai");
    const member = await addMember(family, privateKey, publicKey);
    const other = await createFamily(privateKey, publicKey, "Other");
    const today = spaceToday("Asia/Shanghai");
    const anchor = addDateDays(today, -10);
    const occurrence = addDateDays(today, -5);

    const invalid = await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid subject",
        kind: "elapsed",
        anchorDate: today,
        subjectPersonId: other.ownerPersonId,
      }),
    });
    expect(invalid.status).toBe(400);

    const created = await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        name: "Filter service",
        kind: "cycle",
        anchorDate: anchor,
        cycleDays: 30,
        subjectPersonId: member.personId,
      }),
    });
    expect(created.status).toBe(201);
    const record = await data<{
      id: string;
      status: string;
      subjectPersonId: string;
      version: number;
      computed: { temporal: { nextDueDate: string; remainingDays: number } };
    }>(created);
    expect(record).toMatchObject({
      status: "active",
      subjectPersonId: member.personId,
      version: 1,
      computed: { temporal: { nextDueDate: addDateDays(anchor, 30), remainingDays: 20 } },
    });

    const advanced = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/actions/record-occurrence`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ occurredOn: occurrence, note: "Done", version: 1 }),
    });
    expect(advanced.status).toBe(200);
    expect(await data<{ anchorDate: string; version: number }>(advanced))
      .toMatchObject({ anchorDate: occurrence, version: 2 });

    const history = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/occurrences`, family.ownerToken, publicKey);
    const occurrences = await data<{ items: Array<{ source: string; intervalDays: number | null }> }>(history);
    expect(occurrences.items.map((item) => item.source).sort()).toEqual(["initial", "manual"]);
    expect(occurrences.items.find((item) => item.source === "manual")?.intervalDays).toBe(5);

    const attention = await request(
      `/api/v1/spaces/${family.spaceId}/day-records?attentionOnly=false&sort=effectiveDate:asc`,
      family.ownerToken,
      publicKey,
    );
    expect((await data<{ items: Array<{ id: string }> }>(attention)).items.map((item) => item.id)).toContain(record.id);

    const archived = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/actions/archive`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(await data<{ status: string; version: number }>(archived))
      .toMatchObject({ status: "archived", version: 3 });

    const blocked = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ name: "Blocked", version: 3 }),
    });
    expect(blocked.status).toBe(409);

    const restored = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}/actions/restore`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    });
    expect(await data<{ status: string; version: number }>(restored))
      .toMatchObject({ status: "active", version: 4 });

    expect((await request(`/api/v1/spaces/${family.spaceId}/members/${member.userId}`, family.ownerToken, publicKey, {
      method: "DELETE",
    })).status).toBe(204);

    const historical = await request(`/api/v1/spaces/${family.spaceId}/day-records/${record.id}`, family.ownerToken, publicKey);
    expect(await data<{ subjectPersonId: string }>(historical)).toMatchObject({ subjectPersonId: member.personId });

    const inactive = await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        name: "Inactive subject",
        kind: "elapsed",
        anchorDate: today,
        subjectPersonId: member.personId,
      }),
    });
    expect(inactive.status).toBe(400);
  });

  it("runs the two-state Wish lifecycle through Policy + Workflow", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey);

    const created = await request(`/api/v1/spaces/${family.spaceId}/wishes`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        title: "New boots",
        desiredDate: "2026-09-01",
        ownerPersonId: family.ownerPersonId,
      }),
    });
    expect(created.status).toBe(201);
    const wish = await data<{
      id: string;
      modelVersion: number;
      status: string;
      ownerPersonId: string;
      fulfilledAt: string | null;
      version: number;
    }>(created);
    expect(wish).toMatchObject({
      modelVersion: 4,
      status: "open",
      ownerPersonId: family.ownerPersonId,
      version: 1,
    });

    const memberEdit = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}`, member.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "Not mine to edit" }),
    });
    expect(memberEdit.status).toBe(403);

    const fulfilled = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/actions/fulfill`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(fulfilled.status).toBe(200);
    const fulfilledWish = await data<{ status: string; fulfilledAt: string | null; version: number }>(fulfilled);
    expect(fulfilledWish).toMatchObject({ status: "fulfilled", version: 2 });
    expect(fulfilledWish.fulfilledAt).toMatch(/T/);

    const reopened = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/actions/reopen`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(reopened.status).toBe(200);
    expect(await data<{ status: string; fulfilledAt: string | null; version: number }>(reopened))
      .toMatchObject({ status: "open", fulfilledAt: null, version: 3 });

    const ownerEdit = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 3, title: "New hiking boots" }),
    });
    expect(ownerEdit.status).toBe(200);
    expect(await data<{ title: string; version: number }>(ownerEdit))
      .toMatchObject({ title: "New hiking boots", version: 4 });
  });

  it("does not couple fulfilled Wish state to later family-member removal", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey, "Wish independence");
    const member = await addMember(family, privateKey, publicKey, "Helper");

    const created = await request(`/api/v1/spaces/${family.spaceId}/wishes`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ title: "Family memory", ownerPersonId: family.ownerPersonId }),
    });
    const wish = await data<{ id: string }>(created);

    const fulfilled = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}/actions/fulfill`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(await data<{ status: string; version: number }>(fulfilled))
      .toMatchObject({ status: "fulfilled", version: 2 });

    expect((await request(`/api/v1/spaces/${family.spaceId}/members/${member.userId}`, family.ownerToken, publicKey, {
      method: "DELETE",
    })).status).toBe(204);

    const current = await request(`/api/v1/spaces/${family.spaceId}/wishes/${wish.id}`, family.ownerToken, publicKey);
    expect(current.status).toBe(200);
    expect(await data<{ status: string; version: number }>(current))
      .toMatchObject({ status: "fulfilled", version: 2 });
  });
});
