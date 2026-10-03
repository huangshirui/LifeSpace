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
async function token(privateKey: string, userId: string, agentId?: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity", aud: "lifespace-core", sub: agentId ?? userId, azp: "batch-test-app",
    principal_type: "user", scope: "resources:read resources:write", iat, exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
    ...(agentId ? { principal_id: userId, actor_type: "agent", actor_id: agentId, purpose: "agent_execution" } : {}),
  }, privateKey, "RS256");
}
function auth(value: string) { return { authorization: `Bearer ${value}`, "content-type": "application/json" }; }
async function call(publicKey: string, bearer: string, path: string, body: unknown) {
  return createApp().request(`http://localhost${path}`, {
    method: "POST", headers: auth(bearer), body: JSON.stringify(body),
  }, { DB: (env as unknown as TestEnv).DB, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" });
}
async function json(response: Response) { return response.json<any>(); }

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "Batch", userId, now, now, "UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    ...["task","event"].map((key) => db.prepare(
      "INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?) ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access"
    ).bind("batch-test-app", key, "write", "user", userId)),
  ]);
}
async function createTask(publicKey: string, bearer: string, spaceId: string, name: string) {
  const response = await call(publicKey, bearer, `/api/v1/spaces/${spaceId}/models/task/records`, { name, assigneePersonIds: [] });
  expect(response.status).toBe(201);
  return (await json(response)).data;
}
async function singleUse(publicKey: string, direct: string, spaceId: string, agentId: string) {
  const response = await call(publicKey, direct, `/api/v1/spaces/${spaceId}/delegations`, {
    actor: { type: "agent", id: agentId },
    scope: { target: { type: "model", id: "task" }, maxAccess: "write" },
    constraints: { maxUses: 1 },
  });
  expect(response.status).toBe(201);
  return (await json(response)).data.id as string;
}

describe("first-class Batch Runtime", () => {
  it("atomically creates 20 records and records one ChangeSet with 20 Changes", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const response = await call(publicKey, direct, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: Array.from({ length: 20 }, (_, i) => ({
        operation: "create", modelKey: "task", data: { name: `Batch ${i}`, assigneePersonIds: [] },
      })),
    });
    expect(response.status).toBe(200);
    const result = (await json(response)).data;
    expect(result.items).toHaveLength(20);
    expect(result.changeSetId).toMatch(/^cgs_/);
    const db = (env as unknown as TestEnv).DB;
    const changes = await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE change_set_id=?")
      .bind(result.changeSetId).first<{ count: number }>();
    const set = await db.prepare("SELECT operation_count,committed_at FROM resource_change_sets WHERE id=?")
      .bind(result.changeSetId).first<{ operation_count: number; committed_at: string | null }>();
    expect(changes?.count).toBe(20);
    expect(set?.operation_count).toBe(20);
    expect(set?.committed_at).toBeTruthy();
  });

  it("commits mixed cross-model CRUD atomically and rolls everything back on a stale item", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const updateTarget = await createTask(publicKey, direct, spaceId, "update");
    const deleteTarget = await createTask(publicKey, direct, spaceId, "delete");
    const ok = await call(publicKey, direct, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: [
        { operation: "update", modelKey: "task", recordId: updateTarget.id, data: { name: "updated" } },
        { operation: "delete", modelKey: "task", recordId: deleteTarget.id },
        { operation: "create", modelKey: "event", data: { summary: "batch event", when: { kind: "date", start: "2026-10-02", endExclusive: "2026-10-03" } } },
      ],
    });
    expect(ok.status).toBe(200);
    const okResult = (await json(ok)).data;
    expect(okResult.items[0].version).toBe(updateTarget.version + 1);
    expect(okResult.items[1].version).toBe(deleteTarget.version + 1);
    expect(okResult.items[2].version).toBe(1);

    const db = (env as unknown as TestEnv).DB;
    const countBefore = await db.prepare("SELECT COUNT(*) count FROM resource_records WHERE space_id=? AND model_key='task'")
      .bind(spaceId).first<{ count: number }>();
    const stale = await call(publicKey, direct, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: [
        { operation: "create", modelKey: "task", data: { name: "rollback", assigneePersonIds: [] } },
        { operation: "update", modelKey: "task", recordId: updateTarget.id, version: 999999, data: { name: "stale" } },
      ],
    });
    expect(stale.status).toBe(409);
    const countAfter = await db.prepare("SELECT COUNT(*) count FROM resource_records WHERE space_id=? AND model_key='task'")
      .bind(spaceId).first<{ count: number }>();
    expect(countAfter?.count).toBe(countBefore?.count);

    const invalidVersion = await call(publicKey, direct, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: [
        { operation: "delete", modelKey: "task", recordId: updateTarget.id, version: 0 },
      ],
    });
    expect(invalidVersion.status).toBe(400);
  });

  it("atomically consumes distinct single-use Delegations and rejects one selector reused twice", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, userId);
    const agent = await token(privateKey, userId, agentId);
    const first = await singleUse(publicKey, direct, spaceId, agentId);
    const second = await singleUse(publicKey, direct, spaceId, agentId);
    const ok = await call(publicKey, agent, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: [
        { operation: "create", modelKey: "task", delegationId: first, data: { name: "a", assigneePersonIds: [] } },
        { operation: "create", modelKey: "task", delegationId: second, data: { name: "b", assigneePersonIds: [] } },
      ],
    });
    expect(ok.status).toBe(200);
    const db = (env as unknown as TestEnv).DB;
    const consumed = await db.prepare("SELECT COUNT(*) count FROM delegations WHERE id IN (?,?) AND consumed_at IS NOT NULL")
      .bind(first, second).first<{ count: number }>();
    expect(consumed?.count).toBe(2);

    const third = await singleUse(publicKey, direct, spaceId, agentId);
    const reused = await call(publicKey, agent, `/api/v1/spaces/${spaceId}/models/batch`, {
      operations: [
        { operation: "create", modelKey: "task", delegationId: third, data: { name: "c", assigneePersonIds: [] } },
        { operation: "create", modelKey: "task", delegationId: third, data: { name: "d", assigneePersonIds: [] } },
      ],
    });
    expect(reused.status).toBe(403);
    const state = await db.prepare("SELECT consumed_at FROM delegations WHERE id=?")
      .bind(third).first<{ consumed_at: string | null }>();
    expect(state?.consumed_at).toBeNull();
  });
});
