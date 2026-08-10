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

async function token(privateKey: string, userId: string, clientId = "homemew-miniprogram", scopes = "spaces:read spaces:write spaces:manage tasks:read tasks:write") {
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

async function createTask(familyId: string, accessToken: string, publicKey: string, input: Record<string, unknown>) {
  return request(`/api/v1/families/${familyId}/tasks`, accessToken, publicKey, { method: "POST", body: JSON.stringify(input) });
}

describe("Tasks and assignees", () => {
  it("stores one Space task while preserving HomeMew assignee and actor shapes", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey);
    await joinMember(familyId, ownerToken, memberToken, publicKey);

    const created = await createTask(familyId, ownerToken, publicKey, {
      name: "Homework", description: "Math", dueDate: "2026-08-12", assigneeIds: [memberId],
    });
    expect(created.status).toBe(201);
    const task = (await created.json<{ data: Record<string, any> }>()).data;
    expect(task).toMatchObject({
      familyId, name: "Homework", dueDate: "2026-08-12", status: "pending",
      assignees: [{ userId: memberId, displayName: "Member", avatarUrl: null }],
      createdBy: { type: "user", id: ownerId, name: "Owner", avatarUrl: null }, version: 1,
    });

    const persisted = await (env as TestEnv).DB.prepare(`SELECT t.space_id,ta.person_id,map.legacy_user_id FROM tasks t
      JOIN task_assignees ta ON ta.task_id=t.id JOIN legacy_homemew_membership_maps map ON map.person_id=ta.person_id WHERE t.id=?`)
      .bind(task.id).first<{ space_id: string; person_id: string; legacy_user_id: string }>();
    expect(persisted?.space_id).toMatch(/^spc_/);
    expect(persisted?.person_id).toMatch(/^per_/);
    expect(persisted?.legacy_user_id).toBe(memberId);

    const native = await request(`/api/v1/spaces/${persisted?.space_id}/tasks/${task.id}`, ownerToken, publicKey);
    expect((await native.json<{ data: Record<string, unknown> }>()).data).toMatchObject({
      spaceId: persisted?.space_id, assignees: [{ personId: persisted?.person_id, displayName: "Member" }],
    });
  });

  it("updates assignees atomically and rejects stale versions and invalid cross-Space people", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`, memberId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(memberId, "Member");
    const ownerToken = await token(privateKey, ownerId), memberToken = await token(privateKey, memberId);
    const familyId = await createFamily(ownerToken, publicKey); await joinMember(familyId, ownerToken, memberToken, publicKey);
    const task = (await (await createTask(familyId, ownerToken, publicKey, { name: "One", assigneeIds: [ownerId] })).json<{ data: { id: string } }>()).data;
    const updated = await request(`/api/v1/families/${familyId}/tasks/${task.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 1, dueDate: "2026-08-20", assigneeIds: [memberId] }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ version: 2, dueDate: "2026-08-20", assignees: [{ userId: memberId }] });
    const stale = await request(`/api/v1/families/${familyId}/tasks/${task.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 1, name: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("TASK_VERSION_CONFLICT");

    const otherFamily = await createFamily(ownerToken, publicKey);
    const otherPerson = await (env as TestEnv).DB.prepare(`SELECT person_id FROM legacy_homemew_membership_maps WHERE legacy_family_id=? AND legacy_user_id=?`)
      .bind(otherFamily, ownerId).first<{ person_id: string }>();
    const spaceId = await (env as TestEnv).DB.prepare("SELECT space_id FROM legacy_homemew_family_maps WHERE legacy_family_id=?")
      .bind(familyId).first<{ space_id: string }>();
    const invalid = await request(`/api/v1/spaces/${spaceId?.space_id}/tasks/${task.id}`, ownerToken, publicKey, {
      method: "PATCH", body: JSON.stringify({ version: 2, assigneePersonIds: [otherPerson?.person_id] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("completes and reopens with canonical audit data and optimistic versions", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`; await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId); const familyId = await createFamily(accessToken, publicKey);
    const task = (await (await createTask(familyId, accessToken, publicKey, { name: "Action" })).json<{ data: { id: string } }>()).data;
    const completed = await request(`/api/v1/families/${familyId}/tasks/${task.id}/complete`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 1 }),
    });
    const data = (await completed.json<{ data: Record<string, any> }>()).data;
    expect(data).toMatchObject({ status: "completed", version: 2, completedBy: { type: "user", id: ownerId } });
    expect(data.completedAt).toMatch(/Z$/);
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}/complete`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    })).status).toBe(409);
    const reopened = await request(`/api/v1/families/${familyId}/tasks/${task.id}/reopen`, accessToken, publicKey, {
      method: "POST", body: JSON.stringify({ version: 2 }),
    });
    expect((await reopened.json<{ data: Record<string, unknown> }>()).data).toMatchObject({ status: "pending", completedAt: null, completedBy: null, version: 3 });
  });

  it("filters search, assignee, date range, null due dates and bound cursors with HomeMew semantics", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`; await mapUser(ownerId, "Owner");
    const accessToken = await token(privateKey, ownerId); const familyId = await createFamily(accessToken, publicKey);
    for (const input of [
      { name: "Soon football", dueDate: "2026-08-02", assigneeIds: [ownerId] },
      { name: "Later", description: "football gear", dueDate: "2026-08-30", assigneeIds: [ownerId] },
      { name: "No due football", dueDate: null, assigneeIds: [ownerId] },
    ]) expect((await createTask(familyId, accessToken, publicKey, input)).status).toBe(201);

    const query = "status=pending&assigneeId=me&q=football&dueDateFrom=2026-08-01&dueDateTo=2026-08-31&includeNoDue=true&sort=due_asc&limit=1";
    const first = await request(`/api/v1/families/${familyId}/tasks?${query}`, accessToken, publicKey);
    expect(first.status).toBe(200);
    const page = await first.json<{ data: { items: Array<{ name: string }>; nextCursor: string } }>();
    expect(page.data.items[0].name).toBe("Soon football");
    expect(page.data.nextCursor).toBeTruthy();
    const second = await request(`/api/v1/families/${familyId}/tasks?${query}&cursor=${encodeURIComponent(page.data.nextCursor)}`, accessToken, publicKey);
    expect((await second.json<{ data: { items: Array<{ name: string }> } }>()).data.items[0].name).toBe("Later");
    const mismatch = await request(`/api/v1/families/${familyId}/tasks?${query.replace("football", "gear")}&cursor=${encodeURIComponent(page.data.nextCursor)}`, accessToken, publicKey);
    expect(mismatch.status).toBe(400);
    expect((await request(`/api/v1/families/${familyId}/tasks?dueFrom=2026-08-01`, accessToken, publicKey)).status).toBe(400);
  });

  it("enforces scopes, compatibility allowlist, Space authorization and soft deletion", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`, outsiderId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await mapUser(ownerId, "Owner"); await mapUser(outsiderId, "Outsider");
    const ownerToken = await token(privateKey, ownerId), outsiderToken = await token(privateKey, outsiderId);
    const familyId = await createFamily(ownerToken, publicKey);
    const task = (await (await createTask(familyId, ownerToken, publicKey, { name: "Private" })).json<{ data: { id: string } }>()).data;
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}`, outsiderToken, publicKey)).status).toBe(403);
    const noScope = await token(privateKey, ownerId, "homemew-miniprogram", "spaces:read spaces:write spaces:manage");
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}`, noScope, publicKey)).status).toBe(403);
    const otherClient = await token(privateKey, ownerId, "aloha-web");
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}`, otherClient, publicKey)).status).toBe(403);
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}?version=99`, ownerToken, publicKey, { method: "DELETE" })).status).toBe(409);
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}?version=1`, ownerToken, publicKey, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/v1/families/${familyId}/tasks/${task.id}`, ownerToken, publicKey)).status).toBe(404);
    const stored = await (env as TestEnv).DB.prepare("SELECT deleted_at,deleted_by_id,version FROM tasks WHERE id=?")
      .bind(task.id).first<{ deleted_at: string; deleted_by_id: string; version: number }>();
    expect(stored).toMatchObject({ deleted_by_id: ownerId, version: 2 });
    expect(stored?.deleted_at).toMatch(/Z$/);
  });
});
