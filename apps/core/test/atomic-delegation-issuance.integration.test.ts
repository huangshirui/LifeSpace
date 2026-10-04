import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type KeyPair = { privateKey: string; publicKey: string };

type TokenInput = {
  principalId: string;
  actorId?: string;
  appId?: string;
};

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

async function token(privateKey: string, input: TokenInput): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const appId = input.appId ?? "atomic-delegation-test-app";
  if (!input.actorId) {
    return sign({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: input.principalId,
      azp: appId,
      principal_type: "user",
      scope: "resources:read resources:write resources:manage",
      iat,
      exp: iat + 900,
      jti: `tok_${crypto.randomUUID()}`,
    }, privateKey, "RS256");
  }
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: input.actorId,
    azp: appId,
    principal_type: "user",
    principal_id: input.principalId,
    actor_type: "agent",
    actor_id: input.actorId,
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

async function payload(response: Response): Promise<any> {
  return response.json<any>();
}

async function seed(userId: string, spaceId: string, applicationId = "atomic-delegation-test-app") {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Atomic delegation", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    ...["event", "task"].map((modelKey) => db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind(applicationId, modelKey, "manage", "user", userId, now, now)),
  ]);
}

function spec(agentId: string, modelKey: string, maxAccess: "read" | "write" = "write") {
  return {
    actor: { type: "agent", id: agentId },
    scope: { target: { type: "model", id: modelKey }, maxAccess },
  };
}

async function issueRoot(
  publicKey: string,
  direct: string,
  spaceId: string,
  agentId: string,
  options: { maxUses?: 1; remainingRedelegationDepth?: number } = {},
) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/delegations`, direct, {
    method: "POST",
    body: JSON.stringify({
      ...spec(agentId, "event"),
      constraints: options,
    }),
  });
}

async function countDelegations(spaceId: string, createdById?: string): Promise<number> {
  const db = (env as unknown as TestEnv).DB;
  const row = createdById
    ? await db.prepare("SELECT COUNT(*) AS count FROM delegations WHERE source_space_id=? AND created_by_id=?")
      .bind(spaceId, createdById).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM delegations WHERE source_space_id=?")
      .bind(spaceId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

describe("atomic multi-Delegation issuance", () => {
  it("issues multiple independent Root Delegations atomically and preserves input order", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_${suffix}`;
    const spaceId = `spc_atomic_${suffix}`;
    const agentA = `agt_atomic_a_${suffix}`;
    const agentB = `agt_atomic_b_${suffix}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, { principalId: userId });

    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/delegations/batch`, direct, {
      method: "POST",
      body: JSON.stringify({ items: [spec(agentA, "event"), spec(agentB, "task", "read")] }),
    });
    expect(response.status).toBe(201);
    const items = (await payload(response)).data.items;
    expect(items).toHaveLength(2);
    expect(items.map((item: any) => item.actor.id)).toEqual([agentA, agentB]);
    expect(items[0].id).not.toBe(items[1].id);
    expect(items.every((item: any) => item.principal.id === userId && item.parentDelegationId === null)).toBe(true);
    expect(await countDelegations(spaceId)).toBe(2);
  });

  it("persists none when any Root item fails validation", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_fail_${suffix}`;
    const spaceId = `spc_atomic_fail_${suffix}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, { principalId: userId });

    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/delegations/batch`, direct, {
      method: "POST",
      body: JSON.stringify({
        items: [
          spec(`agt_atomic_valid_${suffix}`, "event"),
          spec(`agt_atomic_invalid_${suffix}`, `missing_${suffix}`),
        ],
      }),
    });
    expect(response.status).toBe(404);
    expect((await payload(response)).error.code).toBe("MODEL_NOT_FOUND");
    expect(await countDelegations(spaceId)).toBe(0);
  });

  it("atomically issues multiple Children from one single-use parent without consuming it", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_child_${suffix}`;
    const spaceId = `spc_atomic_child_${suffix}`;
    const agentA = `agt_atomic_parent_${suffix}`;
    const agentB = `agt_atomic_child_b_${suffix}`;
    const agentC = `agt_atomic_child_c_${suffix}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, { principalId: userId });
    const rootResponse = await issueRoot(publicKey, direct, spaceId, agentA, {
      maxUses: 1,
      remainingRedelegationDepth: 1,
    });
    expect(rootResponse.status).toBe(201);
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalId: userId, actorId: agentA });

    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/delegations/batch`, representedA, {
      method: "POST",
      body: JSON.stringify({
        items: [
          { ...spec(agentB, "event"), parentDelegationId: root.id, constraints: { remainingRedelegationDepth: 0 } },
          { ...spec(agentC, "event", "read"), parentDelegationId: root.id, constraints: { remainingRedelegationDepth: 0 } },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const items = (await payload(response)).data.items;
    expect(items).toHaveLength(2);
    expect(items.every((item: any) => item.parentDelegationId === root.id && item.principal.id === userId)).toBe(true);

    const parent = await (env as unknown as TestEnv).DB.prepare(
      "SELECT consumed_at FROM delegations WHERE id=?",
    ).bind(root.id).first<{ consumed_at: string | null }>();
    expect(parent?.consumed_at).toBeNull();
    expect(await countDelegations(spaceId, agentA)).toBe(2);
  });

  it("persists no Children when one item would widen the parent", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_narrow_${suffix}`;
    const spaceId = `spc_atomic_narrow_${suffix}`;
    const agentA = `agt_atomic_narrow_a_${suffix}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, { principalId: userId });
    const rootResponse = await issueRoot(publicKey, direct, spaceId, agentA, { remainingRedelegationDepth: 1 });
    expect(rootResponse.status).toBe(201);
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalId: userId, actorId: agentA });

    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/delegations/batch`, representedA, {
      method: "POST",
      body: JSON.stringify({
        items: [
          { ...spec(`agt_atomic_ok_${suffix}`, "event"), parentDelegationId: root.id },
          { ...spec(`agt_atomic_bad_${suffix}`, "task"), parentDelegationId: root.id },
        ],
      }),
    });
    expect(response.status).toBe(403);
    expect((await payload(response)).error.code).toBe("DELEGATION_SCOPE_INSUFFICIENT");
    expect(await countDelegations(spaceId, agentA)).toBe(0);
  });

  it("enforces the bounded 1..20 request size", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_bound_${suffix}`;
    const spaceId = `spc_atomic_bound_${suffix}`;
    await seed(userId, spaceId);
    const direct = await token(privateKey, { principalId: userId });

    for (const items of [[], Array.from({ length: 21 }, (_, index) => spec(`agt_atomic_bound_${suffix}_${index}`, "event"))]) {
      const response = await request(publicKey, `/api/v1/spaces/${spaceId}/delegations/batch`, direct, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      expect(response.status).toBe(400);
      expect((await payload(response)).error.code).toBe("INVALID_REQUEST");
    }
    expect(await countDelegations(spaceId)).toBe(0);
  });
});
