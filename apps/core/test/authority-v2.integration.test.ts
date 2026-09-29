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

async function token(privateKey: string, userId: string, agentId?: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "authority-v2-test-app",
    principal_type: "user",
    ...(agentId ? {
      actor_type: "agent",
      actor_id: agentId,
      purpose: "delegated_agent",
    } : {}),
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authority v2", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)
      ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind("authority-v2-test-app", "task", "write", "user", userId),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)
      ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind("authority-v2-test-app", "event", "write", "user", userId),
  ]);
}

async function request(publicKey: string, path: string, tokenValue: string, init: RequestInit = {}, delegationId?: string) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${tokenValue}`);
  if (init.body) headers.set("content-type", "application/json");
  if (delegationId) headers.set("x-lifespace-delegation-id", delegationId);
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function payload(response: Response): Promise<any> {
  return response.json<any>();
}

async function issue(
  publicKey: string,
  direct: string,
  spaceId: string,
  agentId: string,
  target: { type: "space" | "model" | "record"; id: string },
  maxAccess: "read" | "write",
  maxUses?: 1,
) {
  const response = await request(publicKey, `/api/v1/spaces/${spaceId}/agent-delegations`, direct, {
    method: "POST",
    body: JSON.stringify({
      agentId,
      scope: { target, maxAccess },
      ...(maxUses ? { constraints: { maxUses } } : {}),
    }),
  });
  expect(response.status).toBe(201);
  return (await payload(response)).data as { id: string; effectiveStatus: string };
}

describe("Authority v2 Delegation execution", () => {
  it("requires an explicit selector and never auto-picks another valid Delegation", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const agent = await token(privateKey, userId, agentId);
    const delegation = await issue(publicKey, direct, spaceId, agentId, { type: "model", id: "task" }, "write");

    const missing = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ name: "must require selector", assigneePersonIds: [] }),
    });
    expect(missing.status).toBe(403);
    expect((await payload(missing)).error.code).toBe("DELEGATION_REQUIRED");

    const wrong = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ name: "must not scan", assigneePersonIds: [] }),
    }, `dlg_${crypto.randomUUID().replaceAll("-", "")}`);
    expect(wrong.status).toBe(403);
    expect((await payload(wrong)).error.code).toBe("DELEGATION_INVALID");

    const ok = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ name: "explicitly delegated", assigneePersonIds: [] }),
    }, delegation.id);
    expect(ok.status).toBe(201);
  });

  it("enforces model and record targets instead of treating write as a global Agent permission", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const agent = await token(privateKey, userId, agentId);

    const created = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, direct, {
      method: "POST",
      body: JSON.stringify({ name: "record scoped", assigneePersonIds: [] }),
    });
    expect(created.status).toBe(201);
    const task = (await payload(created)).data;

    const recordDelegation = await issue(
      publicKey,
      direct,
      spaceId,
      agentId,
      { type: "record", id: task.id },
      "write",
    );

    const list = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/task/records`,
      agent,
      {},
      recordDelegation.id,
    );
    expect(list.status).toBe(403);
    expect((await payload(list)).error.code).toBe("DELEGATION_SCOPE_INSUFFICIENT");

    const patched = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/task/records/${task.id}`,
      agent,
      {
        method: "PATCH",
        body: JSON.stringify({ version: task.version, name: "record scoped update" }),
      },
      recordDelegation.id,
    );
    expect(patched.status).toBe(200);

    const eventDenied = await request(publicKey, `/api/v1/spaces/${spaceId}/models/event/records`, agent, {
      method: "POST",
      body: JSON.stringify({
        summary: "wrong model",
        when: { kind: "date", start: "2026-10-01", endExclusive: "2026-10-02" },
      }),
    }, recordDelegation.id);
    expect(eventDenied.status).toBe(403);
    expect((await payload(eventDenied)).error.code).toBe("DELEGATION_SCOPE_INSUFFICIENT");
  });

  it("does not consume single-use Delegation on validation failure and consumes it atomically on success", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const agent = await token(privateKey, userId, agentId);
    const delegation = await issue(
      publicKey,
      direct,
      spaceId,
      agentId,
      { type: "model", id: "task" },
      "write",
      1,
    );

    const invalid = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ assigneePersonIds: [] }),
    }, delegation.id);
    expect(invalid.status).toBe(400);

    const db = (env as unknown as TestEnv).DB;
    expect((await db.prepare("SELECT consumed_at FROM delegations WHERE id=?")
      .bind(delegation.id).first<{ consumed_at: string | null }>())?.consumed_at).toBeNull();

    const created = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ name: "single use success", assigneePersonIds: [] }),
    }, delegation.id);
    expect(created.status).toBe(201);
    const record = (await payload(created)).data;

    const stored = await db.prepare(`SELECT d.consumed_at,d.consumed_by_change_id,c.record_id
      FROM delegations d
      LEFT JOIN resource_changes c ON c.id=d.consumed_by_change_id
      WHERE d.id=?`).bind(delegation.id).first<{
        consumed_at: string | null;
        consumed_by_change_id: string | null;
        record_id: string | null;
      }>();
    expect(stored?.consumed_at).toBeTruthy();
    expect(stored?.consumed_by_change_id).toMatch(/^chg_/);
    expect(stored?.record_id).toBe(record.id);

    const second = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, agent, {
      method: "POST",
      body: JSON.stringify({ name: "must not consume twice", assigneePersonIds: [] }),
    }, delegation.id);
    expect(second.status).toBe(403);
    expect((await payload(second)).error.code).toBe("DELEGATION_INVALID");
  });

  it("allows at most one concurrent success for one single-use Delegation", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const agent = await token(privateKey, userId, agentId);
    const delegation = await issue(
      publicKey,
      direct,
      spaceId,
      agentId,
      { type: "model", id: "task" },
      "write",
      1,
    );

    const attempt = (name: string) => request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/task/records`,
      agent,
      {
        method: "POST",
        body: JSON.stringify({ name, assigneePersonIds: [] }),
      },
      delegation.id,
    );

    const results = await Promise.all([attempt("race-a"), attempt("race-b")]);
    const successCount = results.filter((response) => response.status === 201).length;
    expect(successCount).toBe(1);

    const db = (env as unknown as TestEnv).DB;
    const count = await db.prepare(`SELECT COUNT(*) count FROM resource_changes WHERE delegation_id=?`)
      .bind(delegation.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
