import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; batchSizes: number[]; preparedSql: string[] };
type KeyPair = { privateKey: string; publicKey: string };

const statementTargets = new WeakMap<object, D1PreparedStatement>();

function countedStatement(statement: D1PreparedStatement): D1PreparedStatement {
  const proxy = new Proxy(statement as object, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => countedStatement(statement.bind(...values));
      }
      return Reflect.get(target, property, statement);
    },
  }) as D1PreparedStatement;
  statementTargets.set(proxy as unknown as object, statement);
  return proxy;
}

function countedDatabase(database: D1Database, counter: Counter): D1Database {
  return new Proxy(database as object, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          counter.preparedSql.push(query);
          return countedStatement(database.prepare(query));
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          counter.roundTrips += 1;
          counter.batchSizes.push(statements.length);
          return database.batch(statements.map((statement) =>
            statementTargets.get(statement as unknown as object) ?? statement
          ));
        };
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;
}

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

async function token(privateKey: string, input: { principalId: string; actorId?: string }): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const applicationId = "atomic-delegation-perf-app";
  if (!input.actorId) {
    return sign({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: input.principalId,
      azp: applicationId,
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
    azp: applicationId,
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

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Atomic issuance perf", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind("atomic-delegation-perf-app", "event", "manage", "user", userId, now, now),
  ]);
}

async function request(
  publicKey: string,
  bearer: string,
  spaceId: string,
  body: unknown,
  database: D1Database,
) {
  return createApp().request(
    `http://localhost/api/v1/spaces/${spaceId}/delegations/batch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { DB: database, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" },
  );
}

function item(actorId: string, parentDelegationId?: string) {
  return {
    actor: { type: "agent", id: actorId },
    ...(parentDelegationId ? { parentDelegationId } : {}),
    scope: { target: { type: "model", id: "event" }, maxAccess: "write" },
    constraints: parentDelegationId ? { remainingRedelegationDepth: 0 } : {},
  };
}

describe("atomic multi-Delegation issuance structural performance", () => {
  it("keeps 20 Root issues bounded to one Authority batch plus one atomic write batch", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_perf_root_${suffix}`;
    const spaceId = `spc_atomic_perf_root_${suffix}`;
    await seed(userId, spaceId);
    const { privateKey, publicKey } = await keys();
    const direct = await token(privateKey, { principalId: userId });
    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [] };

    const response = await request(
      publicKey,
      direct,
      spaceId,
      { items: Array.from({ length: 20 }, (_, index) => item(`agt_atomic_perf_root_${suffix}_${index}`)) },
      countedDatabase(db, counter),
    );

    expect(response.status).toBe(201);
    expect(counter.roundTrips).toBe(2);
    expect(counter.batchSizes).toEqual([1, 40]);
    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(0);
  });

  it("deduplicates one shared parent for 20 Child issues and adds only one chain-read batch", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_atomic_perf_child_${suffix}`;
    const spaceId = `spc_atomic_perf_child_${suffix}`;
    const issuerAgent = `agt_atomic_perf_issuer_${suffix}`;
    await seed(userId, spaceId);
    const { privateKey, publicKey } = await keys();
    const direct = await token(privateKey, { principalId: userId });

    const rootResponse = await createApp().request(
      `http://localhost/api/v1/spaces/${spaceId}/delegations`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${direct}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...item(issuerAgent),
          constraints: { maxUses: 1, remainingRedelegationDepth: 1 },
        }),
      },
      { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" },
    );
    expect(rootResponse.status).toBe(201);
    const root = await rootResponse.json<any>();
    const represented = await token(privateKey, { principalId: userId, actorId: issuerAgent });
    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [] };

    const response = await request(
      publicKey,
      represented,
      spaceId,
      {
        items: Array.from(
          { length: 20 },
          (_, index) => item(`agt_atomic_perf_child_${suffix}_${index}`, root.data.id),
        ),
      },
      countedDatabase(db, counter),
    );

    expect(response.status).toBe(201);
    expect(counter.roundTrips).toBe(3);
    expect(counter.batchSizes).toEqual([1, 1, 40]);
    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(1);

    const parent = await db.prepare("SELECT consumed_at FROM delegations WHERE id=?")
      .bind(root.data.id)
      .first<{ consumed_at: string | null }>();
    expect(parent?.consumed_at).toBeNull();
  });
});
