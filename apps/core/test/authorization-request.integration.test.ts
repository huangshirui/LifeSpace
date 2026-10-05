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

async function agentToken(privateKey: string, agentId: string, applicationId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: agentId,
    azp: applicationId,
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

async function json(response: Response): Promise<any> {
  return response.json<any>();
}

async function seed(userId: string, spaceId: string, applicationId: string) {
  const db = (env as unknown as TestEnv).DB;
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authorization request", userId, timestamp, timestamp, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", timestamp, timestamp),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", timestamp, timestamp),
    ...["event", "task"].map((modelKey) => db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind(applicationId, modelKey, "manage", "user", userId, timestamp, timestamp)),
  ]);
}

function requestedItems() {
  return [
    {
      scope: { target: { type: "model", id: "event" }, maxAccess: "write" },
      constraints: { maxUses: 1 },
    },
    {
      scope: { target: { type: "model", id: "task" }, maxAccess: "read" },
      constraints: {},
    },
  ];
}

async function createRequest(
  publicKey: string,
  bearer: string,
  spaceId: string,
  userId: string,
  extra: Record<string, unknown> = {},
) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests`, bearer, {
    method: "POST",
    body: JSON.stringify({
      principalUserId: userId,
      items: requestedItems(),
      correlation: { sessionId: "session-test", conversationId: "conversation-test" },
      ...extra,
    }),
  });
}

async function delegationCount(spaceId: string): Promise<number> {
  const row = await (env as unknown as TestEnv).DB.prepare(
    "SELECT COUNT(*) AS count FROM delegations WHERE source_space_id=?",
  ).bind(spaceId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

describe("Authorization Request protocol", () => {
  it("creates a pending request, stores only review-token hash, and reuses an identical pending request", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_${suffix}`;
    const agentId = `agt_arq_${suffix}`;
    const spaceId = `spc_arq_${suffix}`;
    const applicationId = `app_arq_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);

    const first = await createRequest(publicKey, bearer, spaceId, userId);
    expect(first.status).toBe(201);
    const firstData = (await json(first)).data;
    expect(firstData.id).toMatch(/^arq_/u);
    expect(firstData.reviewToken).toMatch(/^arv_/u);
    expect(firstData.status).toBe("pending");
    expect(firstData.reused).toBe(false);
    expect(firstData.confirmation.items).toHaveLength(2);
    expect(firstData.confirmation.principal.id).toBe(userId);
    expect(firstData.confirmation.actor.id).toBe(agentId);

    const tokenRows = await (env as unknown as TestEnv).DB.prepare(
      "SELECT token_hash FROM authorization_request_review_tokens WHERE request_id=?",
    ).bind(firstData.id).all<{ token_hash: string }>();
    expect(tokenRows.results).toHaveLength(1);
    expect(JSON.stringify(tokenRows.results)).not.toContain(firstData.reviewToken);

    const second = await createRequest(publicKey, bearer, spaceId, userId, {
      correlation: { sessionId: "another-session" },
      requestTtlMinutes: 5,
    });
    expect(second.status).toBe(201);
    const secondData = (await json(second)).data;
    expect(secondData.id).toBe(firstData.id);
    expect(secondData.reused).toBe(true);
    expect(secondData.reviewToken).not.toBe(firstData.reviewToken);

    const tokensAfterReuse = await (env as unknown as TestEnv).DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_request_review_tokens WHERE request_id=?",
    ).bind(firstData.id).first<{ count: number }>();
    expect(Number(tokensAfterReuse?.count ?? 0)).toBe(2);
  });

  it("confirms one request into multiple independent Delegations atomically", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_confirm_${suffix}`;
    const agentId = `agt_arq_confirm_${suffix}`;
    const spaceId = `spc_arq_confirm_${suffix}`;
    const applicationId = `app_arq_confirm_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);
    const created = await createRequest(publicKey, bearer, spaceId, userId);
    const createdData = (await json(created)).data;

    const confirmed = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${createdData.id}/confirm`,
      bearer,
      {
        method: "POST",
        body: JSON.stringify({
          reviewToken: createdData.reviewToken,
          confirmation: createdData.confirmation,
        }),
      },
    );
    expect(confirmed.status).toBe(200);
    const data = (await json(confirmed)).data;
    expect(data.request.status).toBe("approved");
    expect(data.delegations).toHaveLength(2);
    expect(data.delegations.every((entry: any) => entry.principal.id === userId)).toBe(true);
    expect(data.delegations.every((entry: any) => entry.actor.id === agentId)).toBe(true);
    expect(new Set(data.delegations.map((entry: any) => entry.id)).size).toBe(2);
    expect(await delegationCount(spaceId)).toBe(2);

    const links = await (env as unknown as TestEnv).DB.prepare(
      "SELECT item_index,delegation_id FROM authorization_request_delegations WHERE request_id=? ORDER BY item_index",
    ).bind(createdData.id).all<{ item_index: number; delegation_id: string }>();
    expect(links.results.map((entry) => entry.item_index)).toEqual([0, 1]);
  });

  it("rejects altered confirmation before issuing Authority", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_mismatch_${suffix}`;
    const agentId = `agt_arq_mismatch_${suffix}`;
    const spaceId = `spc_arq_mismatch_${suffix}`;
    const applicationId = `app_arq_mismatch_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);
    const createdData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    const changed = structuredClone(createdData.confirmation);
    changed.items[0].scope.maxAccess = "manage";

    const response = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${createdData.id}/confirm`,
      bearer,
      { method: "POST", body: JSON.stringify({ reviewToken: createdData.reviewToken, confirmation: changed }) },
    );
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe("AUTHORIZATION_CONFIRMATION_MISMATCH");
    expect(await delegationCount(spaceId)).toBe(0);

    const row = await (env as unknown as TestEnv).DB.prepare(
      "SELECT status FROM authorization_requests WHERE id=?",
    ).bind(createdData.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("rechecks current User Authority at confirmation and leaves the request pending on denial", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_stale_${suffix}`;
    const agentId = `agt_arq_stale_${suffix}`;
    const spaceId = `spc_arq_stale_${suffix}`;
    const applicationId = `app_arq_stale_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);
    const createdData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;

    await (env as unknown as TestEnv).DB.prepare(
      "DELETE FROM space_memberships WHERE space_id=? AND user_id=?",
    ).bind(spaceId, userId).run();

    const response = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${createdData.id}/confirm`,
      bearer,
      { method: "POST", body: JSON.stringify({ reviewToken: createdData.reviewToken }) },
    );
    expect(response.status).toBe(403);
    expect(await delegationCount(spaceId)).toBe(0);
    const row = await (env as unknown as TestEnv).DB.prepare(
      "SELECT status FROM authorization_requests WHERE id=?",
    ).bind(createdData.id).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("keeps deny and cancel distinct and never lets a terminal request issue Delegations", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_terminal_${suffix}`;
    const agentId = `agt_arq_terminal_${suffix}`;
    const spaceId = `spc_arq_terminal_${suffix}`;
    const applicationId = `app_arq_terminal_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);

    const deniedData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    const denied = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${deniedData.id}/deny`,
      bearer,
      { method: "POST", body: JSON.stringify({ reviewToken: deniedData.reviewToken }) },
    );
    expect(denied.status).toBe(200);
    expect((await json(denied)).data.status).toBe("denied");

    const confirmDenied = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${deniedData.id}/confirm`,
      bearer,
      { method: "POST", body: JSON.stringify({ reviewToken: deniedData.reviewToken }) },
    );
    expect(confirmDenied.status).toBe(409);

    const cancelledData = (await json(await createRequest(publicKey, bearer, spaceId, userId, {
      items: [{ scope: { target: { type: "model", id: "task" }, maxAccess: "write" } }],
    }))).data;
    const cancelled = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${cancelledData.id}/cancel`,
      bearer,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(cancelled.status).toBe(200);
    expect((await json(cancelled)).data.status).toBe("cancelled");
    expect(await delegationCount(spaceId)).toBe(0);
  });

  it("materializes request expiry and allows only one concurrent confirmation to win", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_race_${suffix}`;
    const agentId = `agt_arq_race_${suffix}`;
    const spaceId = `spc_arq_race_${suffix}`;
    const applicationId = `app_arq_race_${suffix}`;
    await seed(userId, spaceId, applicationId);
    const bearer = await agentToken(privateKey, agentId, applicationId);

    const expiringData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    await (env as unknown as TestEnv).DB.prepare(
      "UPDATE authorization_requests SET request_expires_at=? WHERE id=?",
    ).bind(new Date(Date.now() - 1000).toISOString(), expiringData.id).run();
    const expired = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/authorization-requests/${expiringData.id}`,
      bearer,
    );
    expect(expired.status).toBe(200);
    expect((await json(expired)).data.status).toBe("expired");

    const raceData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    const secondTokenData = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    expect(secondTokenData.id).toBe(raceData.id);

    const confirmations = await Promise.all([
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${raceData.id}/confirm`, bearer, {
        method: "POST",
        body: JSON.stringify({ reviewToken: raceData.reviewToken }),
      }),
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${raceData.id}/confirm`, bearer, {
        method: "POST",
        body: JSON.stringify({ reviewToken: secondTokenData.reviewToken }),
      }),
    ]);
    expect(confirmations.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await delegationCount(spaceId)).toBe(2);
  });
});
