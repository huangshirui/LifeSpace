import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { requireModelAccess } from "../src/model-authorization";
import { getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { preparedSql: string[] };

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
        return async (statements: D1PreparedStatement[]) => database.batch(
          statements.map((statement) => statementTargets.get(statement as unknown as object) ?? statement),
        );
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;
}

async function seedAuthorityFixtures(
  userId: string,
  agentId: string,
  spaceId: string,
  applicationId: string,
): Promise<void> {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authority source capability", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "task", "write", "user", userId, now, now),
    db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,
      permission,created_by_user_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      `grt_${crypto.randomUUID().replaceAll("-", "")}`,
      spaceId,
      "agent",
      agentId,
      "model",
      "task",
      "write",
      userId,
      now,
    ),
  ]);
}

describe("Entity Role Capability Authority Sources", () => {
  it("selects Base Authority sources from the Principal Entity capability without extra D1 I/O", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_source_${suffix}`;
    const agentId = `agt_source_${suffix}`;
    const spaceId = `spc_source_${suffix}`;
    const applicationId = `app_source_${suffix}`;
    await seedAuthorityFixtures(userId, agentId, spaceId, applicationId);

    const model = await getRuntimeModel({ DB: db } as Bindings, "task");
    expect(model).not.toBeNull();
    if (!model) throw new Error("Task model missing");

    const userCounter: Counter = { preparedSql: [] };
    const user: Principal = {
      type: "user",
      id: userId,
      clientId: applicationId,
      scopes: ["resources:write"],
      tokenId: `tok_user_${suffix}`,
    };
    const userDecision = await requireModelAccess(
      { DB: countedDatabase(db, userCounter) } as Bindings,
      user,
      spaceId,
      model,
      "write",
    );

    expect(userDecision.authority.spaceAuthority).toBe("owner");
    expect(userCounter.preparedSql).toHaveLength(1);
    expect(userCounter.preparedSql[0]).toContain("space_memberships");
    expect(userCounter.preparedSql[0]).toContain("data_grants");

    const agentCounter: Counter = { preparedSql: [] };
    const agent: Principal = {
      type: "agent",
      id: agentId,
      clientId: applicationId,
      scopes: ["resources:write"],
      tokenId: `tok_agent_${suffix}`,
    };
    const agentDecision = await requireModelAccess(
      { DB: countedDatabase(db, agentCounter) } as Bindings,
      agent,
      spaceId,
      model,
      "write",
    );

    expect(agentDecision.authority.spaceAuthority).toBe("grant");
    expect(agentCounter.preparedSql).toHaveLength(1);
    expect(agentCounter.preparedSql[0]).not.toContain("space_memberships");
    expect(agentCounter.preparedSql[0]).toContain("data_grants");
  });
});
