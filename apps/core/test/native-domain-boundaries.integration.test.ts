import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { addDateDays, spaceToday } from "../src/day-calculation";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type Family = { spaceId: string; ownerId: string; ownerPersonId: string; ownerToken: string };
type Member = { userId: string; personId: string; accessToken: string };

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

const allScopes = [
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

async function token(
  privateKey: string,
  userId: string,
  requestedScopes: string[] = allScopes,
  clientId = "homemew-miniprogram",
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: requestedScopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function createFamily(privateKey: string, publicKey: string, label = "Home"): Promise<Family> {
  const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const ownerToken = await token(privateKey, ownerId);
  const response = await request("/api/v1/spaces", ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: label, ownerDisplayName: `${label} owner`, timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json<{ data: { id: string; ownerPersonId: string } }>();
  return { spaceId: payload.data.id, ownerId, ownerPersonId: payload.data.ownerPersonId, ownerToken };
}

async function addMember(
  family: Family,
  privateKey: string,
  publicKey: string,
  displayName = "Member",
): Promise<Member> {
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await request(`/api/v1/spaces/${family.spaceId}/members`, family.ownerToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ userId, role: "editor", displayName }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json<{ data: { personId: string } }>();
  return { userId, personId: payload.data.personId, accessToken: await token(privateKey, userId) };
}

async function removeMember(family: Family, member: Member, publicKey: string) {
  const response = await request(`/api/v1/spaces/${family.spaceId}/members/${member.userId}`, family.ownerToken, publicKey, { method: "DELETE" });
  expect(response.status).toBe(204);
}

describe("native domain boundary coverage after HomeMew compatibility retirement", () => {
  it("binds Event search/attendee pagination cursors and enforces scope + Space authorization without a HomeMew client allowlist", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const outsider = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const outsiderToken = await token(privateKey, outsider);

    for (const payload of [
      { summary: "Alpha football", isAllDay: false, startAt: "2026-08-10T16:00:00Z", endAt: "2026-08-10T17:00:00Z", attendeePersonIds: [family.ownerPersonId] },
      { summary: "Beta holiday", description: "football break", isAllDay: true, startDate: "2026-08-11", endDateExclusive: "2026-08-13", attendeePersonIds: [family.ownerPersonId] },
      { summary: "Outside", isAllDay: true, startDate: "2026-09-01", endDateExclusive: "2026-09-02" },
    ]) {
      expect((await request(`/api/v1/spaces/${family.spaceId}/events`, family.ownerToken, publicKey, {
        method: "POST",
        body: JSON.stringify(payload),
      })).status).toBe(201);
    }

    const query = "startDate=2026-08-10&endDateExclusive=2026-08-14&q=football&attendeePersonId=me&limit=1";
    const first = await request(`/api/v1/spaces/${family.spaceId}/events?${query}`, family.ownerToken, publicKey);
    expect(first.status).toBe(200);
    const firstPage = await first.json<{ data: { items: Array<{ summary: string }>; nextCursor: string } }>();
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/spaces/${family.spaceId}/events?${query}&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`, family.ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ summary: string }>; nextCursor: null } }>()).data.items).toHaveLength(1);
    const mismatch = await request(`/api/v1/spaces/${family.spaceId}/events?startDate=2026-08-10&endDateExclusive=2026-08-15&q=football&attendeePersonId=me&limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`, family.ownerToken, publicKey);
    expect(mismatch.status).toBe(400);

    const noEventScope = await token(privateKey, family.ownerId, ["spaces:read", "spaces:write", "spaces:manage"]);
    expect((await request(`/api/v1/spaces/${family.spaceId}/events?startDate=2026-08-10&endDateExclusive=2026-08-14`, noEventScope, publicKey)).status).toBe(403);
    expect((await request(`/api/v1/spaces/${family.spaceId}/events?startDate=2026-08-10&endDateExclusive=2026-08-14`, outsiderToken, publicKey)).status).toBe(403);

    const alohaToken = await token(privateKey, family.ownerId, allScopes, "aloha-web");
    expect((await request(`/api/v1/spaces/${family.spaceId}/events?startDate=2026-08-10&endDateExclusive=2026-08-14`, alohaToken, publicKey)).status).toBe(200);
  });

  it("keeps Task cursor/includeNoDue behavior, cross-Space assignee isolation, scope checks and soft-delete metadata", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const other = await createFamily(privateKey, publicKey, "Other");
    const outsiderToken = await token(privateKey, other.ownerId);

    for (const input of [
      { name: "Soon football", dueDate: "2026-08-02", assigneePersonIds: [family.ownerPersonId] },
      { name: "Later", description: "football gear", dueDate: "2026-08-30", assigneePersonIds: [family.ownerPersonId] },
      { name: "No due football", dueDate: null, assigneePersonIds: [family.ownerPersonId] },
    ]) {
      expect((await request(`/api/v1/spaces/${family.spaceId}/tasks`, family.ownerToken, publicKey, {
        method: "POST",
        body: JSON.stringify(input),
      })).status).toBe(201);
    }

    const query = "status=pending&assigneePersonId=me&q=football&dueDateFrom=2026-08-01&dueDateTo=2026-08-31&includeNoDue=true&sort=due_asc&limit=1";
    const first = await request(`/api/v1/spaces/${family.spaceId}/tasks?${query}`, family.ownerToken, publicKey);
    const page = await first.json<{ data: { items: Array<{ id: string; name: string; version: number }>; nextCursor: string } }>();
    expect(page.data.items[0].name).toBe("Soon football");
    expect(page.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/spaces/${family.spaceId}/tasks?${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ name: string }> } }>()).data.items[0].name).toBe("Later");
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks?${query.replace("football", "gear")}&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey)).status).toBe(400);
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks?dueFrom=2026-08-01`, family.ownerToken, publicKey)).status).toBe(400);

    const invalid = await request(`/api/v1/spaces/${family.spaceId}/tasks/${page.data.items[0].id}`, family.ownerToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: page.data.items[0].version, assigneePersonIds: [other.ownerPersonId] }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<{ error: { code: string } }>()).error.code).toBe("INVALID_ASSIGNEE");

    const noTaskScope = await token(privateKey, family.ownerId, ["spaces:read", "spaces:write", "spaces:manage"]);
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks`, noTaskScope, publicKey)).status).toBe(403);
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks`, outsiderToken, publicKey)).status).toBe(403);

    const deleteTarget = (await (await request(`/api/v1/spaces/${family.spaceId}/tasks`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: "Delete me" }),
    })).json<{ data: { id: string; version: number } }>()).data;
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks/${deleteTarget.id}?version=99`, family.ownerToken, publicKey, { method: "DELETE" })).status).toBe(409);
    expect((await request(`/api/v1/spaces/${family.spaceId}/tasks/${deleteTarget.id}?version=${deleteTarget.version}`, family.ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
    const stored = await (env as unknown as TestEnv).DB.prepare("SELECT deleted_at,deleted_by_id,version FROM tasks WHERE id=?")
      .bind(deleteTarget.id).first<{ deleted_at: string; deleted_by_id: string; version: number }>();
    expect(stored).toMatchObject({ deleted_by_id: family.ownerId, version: deleteTarget.version + 1 });
    expect(stored?.deleted_at).toMatch(/Z$/);
  });

  it("preserves Day Record kinds/defaults, attention cursors and historical Person refs while rejecting inactive/cross-Space subjects", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey, "Former member");
    const other = await createFamily(privateKey, publicKey, "Other");
    const current = spaceToday("Asia/Shanghai");

    const elapsed = (await (await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: "Haircut", kind: "elapsed", anchorDate: current, subjectPersonId: member.personId }),
    })).json<{ data: Record<string, any> }>()).data;
    expect(elapsed).toMatchObject({
      spaceId: family.spaceId,
      kind: "elapsed",
      attentionAfterDays: null,
      subject: { personId: member.personId, displayName: "Former member" },
      status: "active",
      version: 1,
      computed: { today: current, elapsedDays: 0, state: "normal" },
    });

    const countdown = (await (await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: "Trip", kind: "countdown", anchorDate: current }),
    })).json<{ data: Record<string, any> }>()).data;
    expect(countdown).toMatchObject({ kind: "countdown", attentionBeforeDays: 30, computed: { remainingDays: 0, state: "today" } });
    const countdownHistory = await request(`/api/v1/spaces/${family.spaceId}/day-records/${countdown.id}/occurrences`, family.ownerToken, publicKey);
    expect((await countdownHistory.json<{ data: { items: unknown[] } }>()).data.items).toEqual([]);
    const forbiddenOccurrence = await request(`/api/v1/spaces/${family.spaceId}/day-records/${countdown.id}/occurrences`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ occurredOn: current, version: 1 }),
    });
    expect(forbiddenOccurrence.status).toBe(409);
    expect((await forbiddenOccurrence.json<{ error: { code: string } }>()).error.code).toBe("OCCURRENCE_NOT_ALLOWED");
    const archivedCountdown = await request(`/api/v1/spaces/${family.spaceId}/day-records/${countdown.id}/archive`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(archivedCountdown.status).toBe(200);

    for (const input of [
      { name: "Critical", kind: "countdown", anchorDate: addDateDays(current, -1) },
      { name: "Warning", kind: "cycle", anchorDate: addDateDays(current, -9), cycleDays: 10, attentionBeforeDays: 2 },
      { name: "Info", kind: "countdown", anchorDate: addDateDays(current, 5), attentionBeforeDays: 7 },
      { name: "None", kind: "elapsed", anchorDate: current },
    ]) {
      expect((await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
        method: "POST",
        body: JSON.stringify(input),
      })).status).toBe(201);
    }
    const query = "status=active&attentionOnly=true&sort=attention&limit=2";
    const first = await request(`/api/v1/spaces/${family.spaceId}/day-records?${query}`, family.ownerToken, publicKey);
    const page = await first.json<{ data: { items: Array<{ name: string }>; nextCursor: string } }>();
    expect(page.data.items.map((item) => item.name)).toEqual(["Critical", "Warning"]);
    const second = await request(`/api/v1/spaces/${family.spaceId}/day-records?${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ name: string }> } }>()).data.items.map((item) => item.name)).toEqual(["Info"]);
    expect((await request(`/api/v1/spaces/${family.spaceId}/day-records?kind=countdown&${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey)).status).toBe(400);

    await removeMember(family, member, publicKey);
    const historical = await request(`/api/v1/spaces/${family.spaceId}/day-records/${elapsed.id}`, family.ownerToken, publicKey);
    expect((await historical.json<{ data: Record<string, any> }>()).data.subject).toMatchObject({ personId: member.personId, displayName: "Former member" });
    const inactiveFilter = await request(`/api/v1/spaces/${family.spaceId}/day-records?subjectPersonId=${member.personId}`, family.ownerToken, publicKey);
    expect(inactiveFilter.status).toBe(400);
    expect((await inactiveFilter.json<{ error: { code: string } }>()).error.code).toBe("INVALID_DAY_RECORD_SUBJECT");

    const foreignSubject = await request(`/api/v1/spaces/${family.spaceId}/day-records`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ name: "Invalid", kind: "countdown", anchorDate: current, subjectPersonId: other.ownerPersonId }),
    });
    expect(foreignSubject.status).toBe(400);
    expect((await foreignSubject.json<{ error: { code: string } }>()).error.code).toBe("INVALID_DAY_RECORD_SUBJECT");

    const noDayScope = await token(privateKey, family.ownerId, ["spaces:read", "spaces:write", "spaces:manage"]);
    expect((await request(`/api/v1/spaces/${family.spaceId}/day-records`, noDayScope, publicKey)).status).toBe(403);
  });

  it("preserves Wish ownership/claim permissions, removed-claimant history and restore fallback, plus bound filters/cursors", async () => {
    const { privateKey, publicKey } = await keys();
    const family = await createFamily(privateKey, publicKey);
    const member = await addMember(family, privateKey, publicKey, "Member");

    const firstWish = (await (await request(`/api/v1/spaces/${family.spaceId}/wishes`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ title: "A", desiredDate: "2099-01-01" }),
    })).json<{ data: Record<string, any> }>()).data;
    for (const input of [
      { title: "B", desiredDate: "2099-02-01" },
      { title: "C" },
    ]) {
      expect((await request(`/api/v1/spaces/${family.spaceId}/wishes`, family.ownerToken, publicKey, {
        method: "POST",
        body: JSON.stringify(input),
      })).status).toBe(201);
    }

    const memberEdit = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}`, member.accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, title: "Hijack" }),
    });
    expect(memberEdit.status).toBe(403);
    expect((await memberEdit.json<{ error: { code: string } }>()).error.code).toBe("WISH_OWNER_REQUIRED");

    const claimed = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}/claim`, member.accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    const claimedData = (await claimed.json<{ data: Record<string, any> }>()).data;
    expect(claimedData).toMatchObject({ status: "claimed", claimant: { personId: member.personId, displayName: "Member" }, version: 2 });
    expect(claimedData.claimedAt).toMatch(/Z$/);

    const ownerUnclaim = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}/unclaim`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect(ownerUnclaim.status).toBe(403);
    expect((await ownerUnclaim.json<{ error: { code: string } }>()).error.code).toBe("WISH_CLAIMANT_REQUIRED");

    const claimedFilter = await request(`/api/v1/spaces/${family.spaceId}/wishes?status=claimed&claimantPersonId=me&desiredFrom=2099-01-01&desiredTo=2099-12-31`, member.accessToken, publicKey);
    const claimedPage = await claimedFilter.json<{ data: { items: Array<Record<string, any>> } }>();
    expect(claimedPage.data.items).toHaveLength(1);
    expect(claimedPage.data.items[0]).toMatchObject({ id: firstWish.id, claimant: { personId: member.personId } });

    const ownerQuery = `ownerPersonId=${family.ownerPersonId}&sort=desired_asc&limit=2`;
    const first = await request(`/api/v1/spaces/${family.spaceId}/wishes?${ownerQuery}`, family.ownerToken, publicKey);
    const page = await first.json<{ data: { items: Array<{ title: string }>; nextCursor: string } }>();
    expect(page.data.items.map((item) => item.title)).toEqual(["A", "B"]);
    expect(page.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/spaces/${family.spaceId}/wishes?${ownerQuery}&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ title: string }> } }>()).data.items.map((item) => item.title)).toEqual(["C"]);
    const mismatch = await request(`/api/v1/spaces/${family.spaceId}/wishes?ownerPersonId=${family.ownerPersonId}&status=open&sort=desired_asc&limit=2&cursor=${encodeURIComponent(page.data.nextCursor)}`, family.ownerToken, publicKey);
    expect(mismatch.status).toBe(400);

    const archived = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}/archive`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
    });
    expect((await archived.json<{ data: Record<string, any> }>()).data).toMatchObject({ status: "archived", claimant: { personId: member.personId }, version: 3 });

    await removeMember(family, member, publicKey);
    const historical = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}`, family.ownerToken, publicKey);
    expect((await historical.json<{ data: Record<string, any> }>()).data.claimant).toMatchObject({ personId: member.personId, displayName: "Member" });
    const restored = await request(`/api/v1/spaces/${family.spaceId}/wishes/${firstWish.id}/restore`, family.ownerToken, publicKey, {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    });
    expect((await restored.json<{ data: Record<string, any> }>()).data).toMatchObject({ status: "open", claimant: null, claimedAt: null, version: 4 });

    const noWishScope = await token(privateKey, family.ownerId, ["spaces:read", "spaces:write", "spaces:manage"]);
    expect((await request(`/api/v1/spaces/${family.spaceId}/wishes`, noWishScope, publicKey)).status).toBe(403);
  });
});
