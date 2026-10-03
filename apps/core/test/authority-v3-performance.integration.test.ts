import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { requireModelAccessMany } from "../src/model-authorization";
import { getRuntimeModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = {
  roundTrips: number;
  batchSizes: number[];
  preparedSql: string[];
  resultRows: number[][];
};

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
          const results = await database.batch(statements.map((statement) =>
            statementTargets.get(statement as unknown as object) ?? statement
          ));
          counter.resultRows.push(results.map((result) => result.results?.length ?? 0));
          return results;
        };
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;
}

function reset(counter: Counter): void {
  counter.roundTrips = 0;
  counter.batchSizes = [];
  counter.preparedSql = [];
  counter.resultRows = [];
}

async function seed(userId: string, agentId: string, spaceId: string, applicationId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authority v3 performance", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
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

async function insertDelegation(
  db: D1Database,
  input: {
    id: string;
    principalId: string;
    actorId: string;
    applicationId: string;
    spaceId: string;
    createdByType: "user" | "agent";
    createdById: string;
    parentId: string | null;
    remainingDepth: number;
  },
) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO delegations(
      id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
      created_by_type,created_by_id,created_at,parent_delegation_id,remaining_redelegation_depth
    ) VALUES(?,'user',?,'agent',?,?,?,?,?,?,?,?)`).bind(
      input.id,
      input.principalId,
      input.actorId,
      input.applicationId,
      input.spaceId,
      input.createdByType,
      input.createdById,
      now,
      input.parentId,
      input.remainingDepth,
    ),
    db.prepare(`INSERT INTO delegation_scopes(
      delegation_id,target_type,target_id,target_model_key,max_access
    ) VALUES(?,'model','task','task','write')`).bind(input.id),
  ]);
}

describe("Authority v3 structural performance", () => {
  it("keeps Direct Agent Authority at one D1 round trip for 20 operations", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_v3_perf_${suffix}`;
    const agentId = `agt_v3_perf_${suffix}`;
    const spaceId = `spc_v3_perf_${suffix}`;
    const applicationId = `app_v3_perf_${suffix}`;
    await seed(userId, agentId, spaceId, applicationId);

    const model = await getRuntimeModel({ DB: db } as Bindings, "task");
    expect(model).not.toBeNull();
    if (!model) throw new Error("Task model missing");

    const directAgent: Principal = {
      type: "agent",
      id: agentId,
      clientId: applicationId,
      scopes: ["resources:read", "resources:write"],
      tokenId: `tok_agent_${suffix}`,
    };
    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [], resultRows: [] };
    const bindings = { DB: countedDatabase(db, counter) } as Bindings;

    const decisions = await requireModelAccessMany(
      bindings,
      directAgent,
      spaceId,
      Array.from({ length: 20 }, (_, index) => ({
        model,
        required: "write" as const,
        selector: { recordId: `rec_v3_agent_${suffix}_${index}` },
      })),
    );

    expect(decisions).toHaveLength(20);
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([1]);
    expect(counter.preparedSql).toHaveLength(1);
    expect(counter.preparedSql.some((sql) => sql.includes("WITH RECURSIVE chain"))).toBe(false);
    expect(counter.resultRows).toEqual([[1]]);
  });

  it("resolves the maximum supported Delegation depth in one Authority round trip", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_v3_depth_${suffix}`;
    const grantAgent = `agt_v3_grant_${suffix}`;
    const agents = Array.from({ length: 4 }, (_, index) => `agt_v3_depth_${suffix}_${index}`);
    const spaceId = `spc_v3_depth_${suffix}`;
    const applicationId = `app_v3_depth_${suffix}`;
    await seed(userId, grantAgent, spaceId, applicationId);

    const ids = Array.from({ length: 4 }, (_, index) => `dlg_v3_depth_${suffix}_${index}`);
    await insertDelegation(db, {
      id: ids[0]!, principalId: userId, actorId: agents[0]!, applicationId, spaceId,
      createdByType: "user", createdById: userId, parentId: null, remainingDepth: 3,
    });
    for (let index = 1; index < 4; index += 1) {
      await insertDelegation(db, {
        id: ids[index]!, principalId: userId, actorId: agents[index]!, applicationId, spaceId,
        createdByType: "agent", createdById: agents[index - 1]!, parentId: ids[index - 1]!,
        remainingDepth: 3 - index,
      });
    }

    const model = await getRuntimeModel({ DB: db } as Bindings, "task");
    expect(model).not.toBeNull();
    if (!model) throw new Error("Task model missing");
    const represented: Principal = {
      type: "user",
      id: userId,
      clientId: applicationId,
      scopes: ["resources:read", "resources:write"],
      tokenId: `tok_v3_depth_${suffix}`,
      actor: { type: "agent", id: agents[3]! },
      purpose: "agent_execution",
    };
    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [], resultRows: [] };
    const bindings = { DB: countedDatabase(db, counter) } as Bindings;

    const decisions = await requireModelAccessMany(
      bindings,
      represented,
      spaceId,
      Array.from({ length: 20 }, (_, index) => ({
        model,
        required: "write" as const,
        selector: { delegationId: ids[3], recordId: `rec_v3_depth_${suffix}_${index}` },
      })),
    );

    expect(decisions).toHaveLength(20);
    expect(decisions.every((decision) => decision.authority.delegationChain.length === 4)).toBe(true);
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([2]);
    expect(counter.preparedSql).toHaveLength(2);
    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(1);
    expect(counter.resultRows).toEqual([[1, 4]]);
  });

  it("deduplicates one shared ancestor across 20 different leaf Delegations", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_v3_shared_${suffix}`;
    const grantAgent = `agt_v3_grant_${suffix}`;
    const issuerAgent = `agt_v3_issuer_${suffix}`;
    const finalAgent = `agt_v3_final_${suffix}`;
    const spaceId = `spc_v3_shared_${suffix}`;
    const applicationId = `app_v3_shared_${suffix}`;
    await seed(userId, grantAgent, spaceId, applicationId);

    const rootId = `dlg_v3_shared_root_${suffix}`;
    await insertDelegation(db, {
      id: rootId,
      principalId: userId,
      actorId: issuerAgent,
      applicationId,
      spaceId,
      createdByType: "user",
      createdById: userId,
      parentId: null,
      remainingDepth: 1,
    });
    const leafIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const leafId = `dlg_v3_shared_leaf_${suffix}_${index}`;
      leafIds.push(leafId);
      await insertDelegation(db, {
        id: leafId,
        principalId: userId,
        actorId: finalAgent,
        applicationId,
        spaceId,
        createdByType: "agent",
        createdById: issuerAgent,
        parentId: rootId,
        remainingDepth: 0,
      });
    }

    const model = await getRuntimeModel({ DB: db } as Bindings, "task");
    expect(model).not.toBeNull();
    if (!model) throw new Error("Task model missing");
    const represented: Principal = {
      type: "user",
      id: userId,
      clientId: applicationId,
      scopes: ["resources:read", "resources:write"],
      tokenId: `tok_v3_shared_${suffix}`,
      actor: { type: "agent", id: finalAgent },
      purpose: "agent_execution",
    };
    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [], resultRows: [] };
    const bindings = { DB: countedDatabase(db, counter) } as Bindings;

    const decisions = await requireModelAccessMany(
      bindings,
      represented,
      spaceId,
      leafIds.map((delegationId, index) => ({
        model,
        required: "write" as const,
        selector: { delegationId, recordId: `rec_v3_shared_${suffix}_${index}` },
      })),
    );

    expect(decisions).toHaveLength(20);
    expect(decisions.every((decision) => decision.authority.delegationChain.length === 2)).toBe(true);
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([2]);
    expect(counter.preparedSql).toHaveLength(2);
    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(1);
    // 20 unique leaves + one shared root. Returning 40 rows would mean the root
    // was resolved once per leaf even though Worker<->D1 RTT stayed constant.
    expect(counter.resultRows).toEqual([[1, 21]]);
  });
});
