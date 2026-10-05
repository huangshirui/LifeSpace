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

async function agentToken(privateKey: string, agentId: string, appId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: agentId,
    azp: appId,
    principal_type: "agent",
    principal_id: agentId,
    actor_type: "agent",
    actor_id: agentId,
    purpose: "agent_execution",
    scope: "resources:read resources:write resources:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, path: string, bearer: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function json(response: Response): Promise<any> { return response.json<any>(); }

async function seed(userId: string, spaceId: string, appId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authorization request", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    ...["event", "task"].map((modelKey) => db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind(appId, modelKey, "manage", "user", userId, now, now)),
  ]);
}

function createBody(userId: string) {
  return {
    principalUserId: userId,
    requestTtlMinutes: 60,
    correlation: { sessionId: "session-1", conversationId: "conversation-1" },
    items: [
      { scope: { target: { type: "model", id: "event" }, maxAccess: "write" } },
      { scope: { target: { type: "model", id: "task" }, maxAccess: "read" }, constraints: { maxUses: 1 } },
    ],
  };
}

async function createRequest(publicKey: string, bearer: string, spaceId: string, userId: string) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests`, bearer, {
    method: "POST",
    body: JSON.stringify(createBody(userId)),
  });
}

async function countDelegations(db: D1Database, spaceId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM delegations WHERE source_space_id=?")
    .bind(spaceId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function count(db: D1Database, table: string, requestId?: string): Promise<number> {
  const row = requestId
    ? await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE request_id=?`).bind(requestId).first<{ count: number }>()
    : await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

describe("Authorization Request protocol", () => {
  it("creates no Authority, reuses identical pending requests, validates confirmation and atomically issues Delegations", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_${suffix}`;
    const agentId = `agt_arq_${suffix}`;
    const spaceId = `spc_arq_${suffix}`;
    const appId = `app_arq_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;

    const first = await createRequest(publicKey, bearer, spaceId, userId);
    expect(first.status).toBe(201);
    const created = (await json(first)).data;
    expect(created.id).toMatch(/^arq_/u);
    expect(created.status).toBe("pending");
    expect(created.reused).toBe(false);
    expect(created.confirmation.items).toHaveLength(2);
    expect(await countDelegations(db, spaceId)).toBe(0);

    const second = await createRequest(publicKey, bearer, spaceId, userId);
    expect(second.status).toBe(200);
    const reused = (await json(second)).data;
    expect(reused.id).toBe(created.id);
    expect(reused.reused).toBe(true);
    expect(await count(db, "authorization_requests")).toBe(1);

    const wrongUserConfirm = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`,
      bearer,
      { method: "POST", body: JSON.stringify({ principalUserId: `usr_wrong_${suffix}` }) },
    );
    expect(wrongUserConfirm.status).toBe(403);
    expect((await json(wrongUserConfirm)).error.code).toBe("AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH");
    expect(await count(db, "delegations")).toBe(0);

    const mutated = structuredClone(created.confirmation);
    mutated.items[0].scope.maxAccess = "read";
    const mismatch = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({ principalUserId: userId, confirmation: mutated }),
    });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).error.code).toBe("CONFIRMATION_MISMATCH");
    expect(await countDelegations(db, spaceId)).toBe(0);

    const confirmed = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({ principalUserId: userId, confirmation: created.confirmation }),
    });
    expect(confirmed.status).toBe(200);
    const approved = (await json(confirmed)).data;
    expect(approved.status).toBe("approved");
    expect(approved.delegations).toHaveLength(2);
    expect(approved.delegations.every((item: any) => item.principal.id === userId && item.actor.id === agentId)).toBe(true);
    expect(approved.delegations.every((item: any) => item.createdBy.id === agentId)).toBe(true);
    expect(await countDelegations(db, spaceId)).toBe(2);
    expect(await count(db, "authorization_request_delegations", created.id)).toBe(2);

    const repeated = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({ principalUserId: userId }),
    });
    expect(repeated.status).toBe(200);
    const repeatedData = (await json(repeated)).data;
    expect(repeatedData.delegations.map((item: any) => item.id)).toEqual(approved.delegations.map((item: any) => item.id));
    expect(await countDelegations(db, spaceId)).toBe(2);
  });

  it("keeps deny and cancel distinct and never issues Authority", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_terminal_${suffix}`;
    const agentId = `agt_arq_terminal_${suffix}`;
    const spaceId = `spc_arq_terminal_${suffix}`;
    const appId = `app_arq_terminal_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;

    const deniedRequest = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    const wrongUserDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, {
      method: "POST", body: JSON.stringify({ principalUserId: `usr_wrong_${suffix}` }),
    });
    expect(wrongUserDeny.status).toBe(403);
    expect((await json(wrongUserDeny)).error.code).toBe("AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH");

    const denied = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });
    expect(denied.status).toBe(200);
    expect((await json(denied)).data.status).toBe("denied");
    const afterDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });
    expect(afterDeny.status).toBe(409);

    const cancelRequestResponse = await createRequest(publicKey, bearer, spaceId, userId);
    expect(cancelRequestResponse.status).toBe(201);
    const cancelRequest = (await json(cancelRequestResponse)).data;
    expect(cancelRequest.id).not.toBe(deniedRequest.id);
    const cancelled = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${cancelRequest.id}/cancel`, bearer, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect((await json(cancelled)).data.status).toBe("cancelled");
    expect(await countDelegations(db, spaceId)).toBe(0);
  });

  it("rechecks current User Authority at confirm and leaves the request pending on failure", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_stale_${suffix}`;
    const agentId = `agt_arq_stale_${suffix}`;
    const spaceId = `spc_arq_stale_${suffix}`;
    const appId = `app_arq_stale_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;

    await db.prepare("DELETE FROM space_memberships WHERE space_id=? AND user_id=?").bind(spaceId, userId).run();
    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });
    expect(response.status).toBe(403);
    expect(await countDelegations(db, spaceId)).toBe(0);
    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    expect((await json(loaded)).data.status).toBe("pending");
  });

  it("derives expiry and refuses terminal transition after TTL", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_expired_${suffix}`;
    const agentId = `agt_arq_expired_${suffix}`;
    const spaceId = `spc_arq_expired_${suffix}`;
    const appId = `app_arq_expired_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    await db.prepare("UPDATE authorization_requests SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), created.id).run();

    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    expect((await json(loaded)).data.status).toBe("expired");
    const confirm = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });
    expect(confirm.status).toBe(409);
    expect((await json(confirm)).error.code).toBe("AUTHORIZATION_REQUEST_EXPIRED");
    expect(await countDelegations(db, spaceId)).toBe(0);
  });

  it("allows exactly one terminal decision under concurrent confirm/deny", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_race_${suffix}`;
    const agentId = `agt_arq_race_${suffix}`;
    const spaceId = `spc_arq_race_${suffix}`;
    const appId = `app_arq_race_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;

    const [confirm, deny] = await Promise.all([
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) }),
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/deny`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) }),
    ]);
    expect([confirm.status, deny.status].filter((value) => value === 200).length).toBeGreaterThanOrEqual(1);
    const transitionCount = await count(db, "authorization_request_transitions", created.id);
    expect(transitionCount).toBe(1);
    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    const final = (await json(loaded)).data;
    expect(["approved", "denied"]).toContain(final.status);
    if (final.status === "approved") expect(await countDelegations(db, spaceId)).toBe(2);
    else expect(await countDelegations(db, spaceId)).toBe(0);
  });
});
