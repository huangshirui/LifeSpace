import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

type KeyPair = { privateKey: string; publicKey: string };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys(): Promise<KeyPair> {
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

async function userToken(privateKey: string, userId: string, scopes: string[]) {
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

async function agentToken(privateKey: string, userId: string, agentId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    actor_type: "agent",
    actor_id: agentId,
    purpose: "delegated_agent",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, options: RequestInit, publicKey: string) {
  const db = (env as unknown as TestEnv).DB;
  return createApp().request(`http://localhost${path}`, options, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function jsonData(response: Response) {
  const payload = await response.json<{ data: any; error?: any }>();
  return payload.data;
}

async function seedSpaceAndCatalog(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(spaceId, "family", "Agent Ready", userId, now, now).run();
  await db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now).run();
  await db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now).run();
  for (const modelKey of ["event", "task"]) {
    await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)
      ON CONFLICT(application_id,model_key) DO UPDATE SET
        max_access=excluded.max_access,created_by_type=excluded.created_by_type,created_by_id=excluded.created_by_id`)
      .bind("test-app", modelKey, "write", "user", userId).run();
  }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("Agent-ready Authority + Change", () => {
  it("bounds an Agent by delegation, paginates Change History, records attribution and revokes immediately", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedSpaceAndCatalog(userId, spaceId);

    const direct = await userToken(privateKey, userId, ["resources:read", "resources:write"]);
    const createdDelegation = await request(`/api/v1/spaces/${spaceId}/agent-delegations`, {
      method: "POST",
      headers: auth(direct),
      body: JSON.stringify({
        agentId,
        models: [
          { modelKey: "event", maxAccess: "write" },
          { modelKey: "task", maxAccess: "read" },
        ],
      }),
    }, publicKey);
    expect(createdDelegation.status).toBe(201);
    const delegation = await jsonData(createdDelegation);
    expect(delegation.agentId).toBe(agentId);

    const delegated = await agentToken(privateKey, userId, agentId, ["resources:read", "resources:write"]);
    const discoveryResponse = await request(`/api/v1/spaces/${spaceId}/_discovery`, {
      headers: { authorization: `Bearer ${delegated}` },
    }, publicKey);
    expect(discoveryResponse.status).toBe(200);
    const discovery = await jsonData(discoveryResponse);
    const event = discovery.models.find((entry: any) => entry.key === "event");
    const task = discovery.models.find((entry: any) => entry.key === "task");
    expect(event.access).toEqual(["read", "write"]);
    expect(task.access).toEqual(["read"]);

    const eventResponse = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: auth(delegated),
      body: JSON.stringify({
        summary: "Agent-created family event",
        when: { kind: "date", start: "2026-09-06", endExclusive: "2026-09-07" },
      }),
    }, publicKey);
    expect(eventResponse.status).toBe(201);
    const createdEvent = await jsonData(eventResponse);

    const updatedResponse = await request(`/api/v1/spaces/${spaceId}/models/event/records/${createdEvent.id}`, {
      method: "PATCH",
      headers: auth(delegated),
      body: JSON.stringify({
        version: createdEvent.version,
        summary: "Agent-updated family event",
      }),
    }, publicKey);
    expect(updatedResponse.status).toBe(200);

    const taskDenied = await request(`/api/v1/spaces/${spaceId}/models/task/records`, {
      method: "POST",
      headers: auth(delegated),
      body: JSON.stringify({ name: "Must not be created" }),
    }, publicKey);
    expect(taskDenied.status).toBe(403);

    const firstPageResponse = await request(
      `/api/v1/spaces/${spaceId}/changes?recordId=${createdEvent.id}&limit=1`,
      { headers: { authorization: `Bearer ${delegated}` } },
      publicKey,
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await jsonData(firstPageResponse);
    expect(firstPage.items).toHaveLength(1);
    expect(typeof firstPage.nextCursor).toBe("string");
    expect(firstPage.items[0]).toMatchObject({
      operation: "update",
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      applicationId: "test-app",
      delegationId: delegation.id,
      versionBefore: 1,
      versionAfter: 2,
    });

    expect(firstPage.items[0].detailAvailable).toBe(true);
    const exactChangeId = firstPage.items[0].id;
    const detailResponse = await request(
      `/api/v1/spaces/${spaceId}/changes/by-id/${exactChangeId}`,
      { headers: { authorization: `Bearer ${delegated}` } },
      publicKey,
    );
    expect(detailResponse.status).toBe(200);
    const detail = await jsonData(detailResponse);
    expect(detail).toMatchObject({
      id: exactChangeId,
      recordId: createdEvent.id,
      operation: "update",
      detailAvailable: true,
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      delegationId: delegation.id,
    });
    expect(detail.fieldChanges).toEqual([
      {
        field: "summary",
        before: { present: true, value: "Agent-created family event" },
        after: { present: true, value: "Agent-updated family event" },
      },
    ]);

    const secondPageResponse = await request(
      `/api/v1/spaces/${spaceId}/changes?recordId=${createdEvent.id}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { authorization: `Bearer ${delegated}` } },
      publicKey,
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await jsonData(secondPageResponse);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.items[0]).toMatchObject({
      operation: "create",
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      applicationId: "test-app",
      delegationId: delegation.id,
      versionBefore: null,
      versionAfter: 1,
    });

    const wrongRecordCursor = await request(
      `/api/v1/spaces/${spaceId}/changes?recordId=rec_other&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { authorization: `Bearer ${delegated}` } },
      publicKey,
    );
    expect(wrongRecordCursor.status).toBe(400);

    const legacyResponse = await request(`/api/v1/spaces/${spaceId}/changes/${createdEvent.id}`, {
      headers: { authorization: `Bearer ${delegated}` },
    }, publicKey);
    expect(legacyResponse.status).toBe(200);
    const legacy = await jsonData(legacyResponse);
    expect(legacy.items).toHaveLength(2);
    expect(legacy.nextCursor).toBeUndefined();

    const agentCannotSelfGrant = await request(`/api/v1/spaces/${spaceId}/agent-delegations`, {
      method: "POST",
      headers: auth(delegated),
      body: JSON.stringify({ agentId, models: [{ modelKey: "task", maxAccess: "write" }] }),
    }, publicKey);
    expect(agentCannotSelfGrant.status).toBe(403);

    const revoked = await request(`/api/v1/spaces/${spaceId}/agent-delegations/${delegation.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${direct}` },
    }, publicKey);
    expect(revoked.status).toBe(204);

    const detailAfterRevocation = await request(
      `/api/v1/spaces/${spaceId}/changes/by-id/${exactChangeId}`,
      { headers: { authorization: `Bearer ${delegated}` } },
      publicKey,
    );
    expect(detailAfterRevocation.status).toBe(403);

    const afterRevocation = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: auth(delegated),
      body: JSON.stringify({
        summary: "Should be denied after revoke",
        when: { kind: "date", start: "2026-09-07", endExclusive: "2026-09-08" },
      }),
    }, publicKey);
    expect(afterRevocation.status).toBe(403);
  });

  it("ignores unsigned Agent-looking headers and keeps direct-user attribution", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedSpaceAndCatalog(userId, spaceId);
    const direct = await userToken(privateKey, userId, ["resources:read", "resources:write"]);

    const response = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: {
        ...auth(direct),
        "x-agent-id": `agt_${crypto.randomUUID().replaceAll("-", "")}`,
      },
      body: JSON.stringify({
        summary: "Direct user event",
        when: { kind: "date", start: "2026-09-08", endExclusive: "2026-09-09" },
      }),
    }, publicKey);
    expect(response.status).toBe(201);
    const created = await jsonData(response);
    const changesResponse = await request(`/api/v1/spaces/${spaceId}/changes?recordId=${created.id}`, {
      headers: { authorization: `Bearer ${direct}` },
    }, publicKey);
    const changes = await jsonData(changesResponse);
    expect(changes.items[0].actor).toEqual({ type: "user", id: userId });
    expect(changes.items[0].delegationId).toBeNull();
    expect(changes.nextCursor).toBeNull();
  });
});
