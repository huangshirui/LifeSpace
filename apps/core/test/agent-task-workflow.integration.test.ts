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

async function userToken(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function agentToken(privateKey: string, userId: string, agentId: string) {
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
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function request(publicKey: string, path: string, options: RequestInit = {}) {
  const db = (env as unknown as TestEnv).DB;
  return createApp().request(`http://localhost${path}`, options, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function data<T>(response: Response): Promise<T> {
  const payload = await response.json<{ data: T }>();
  return payload.data;
}

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Agent Task", userId, now, now, "UTC").run();
  await db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now).run();
  await db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now).run();
  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
    .bind("test-app", "task", "write", "user", userId).run();
}

describe("Delegated Agent Task Workflow", () => {
  it("completes Task as Agent while preserving User Principal attribution", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await userToken(privateKey, userId);
    const created = await request(publicKey, `/api/v1/spaces/${spaceId}/tasks`, {
      method: "POST",
      headers: auth(direct),
      body: JSON.stringify({ name: "Agent-completable task" }),
    });
    expect(created.status).toBe(201);
    const task = await data<{ id: string; version: number; data: { status: string } }>(created);
    expect(task.data.status).toBe("pending");

    const delegated = await request(publicKey, `/api/v1/spaces/${spaceId}/agent-delegations`, {
      method: "POST",
      headers: auth(direct),
      body: JSON.stringify({ agentId, models: [{ modelKey: "task", maxAccess: "write" }] }),
    });
    expect(delegated.status).toBe(201);
    const delegation = await data<{ id: string }>(delegated);

    const agent = await agentToken(privateKey, userId, agentId);
    const completed = await request(publicKey, `/api/v1/spaces/${spaceId}/tasks/${task.id}/actions/complete`, {
      method: "POST",
      headers: auth(agent),
      body: JSON.stringify({ version: task.version }),
    });
    expect(completed.status).toBe(200);
    const completedTask = await data<{
      version: number;
      data: { status: string; completedByType: string; completedById: string };
    }>(completed);
    expect(completedTask.data).toMatchObject({
      status: "completed",
      completedByType: "agent",
      completedById: agentId,
    });

    const typed = await (env as unknown as TestEnv).DB.prepare(
      `SELECT completedByType,completedById FROM mdl_task WHERE record_id=?`,
    ).bind(task.id).first<{ completedByType: string; completedById: string }>();
    expect(typed).toEqual({ completedByType: "agent", completedById: agentId });

    const history = await request(publicKey, `/api/v1/spaces/${spaceId}/changes/${task.id}`, {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(history.status).toBe(200);
    const changes = await data<{ items: Array<{
      operation: string;
      versionAfter: number;
      principal: { type: string; id: string };
      actor: { type: string; id: string };
      applicationId: string;
      delegationId: string | null;
    }> }>(history);
    const completionChange = changes.items.find((change) => change.operation === "action");
    expect(completionChange).toMatchObject({
      versionAfter: completedTask.version,
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      applicationId: "test-app",
      delegationId: delegation.id,
    });
  });
});
