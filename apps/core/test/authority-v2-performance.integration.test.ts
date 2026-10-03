import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { requireModelAccessMany } from "../src/model-authorization";
import { getRuntimeModel } from "../src/model-registry";
import { requirePolicyExpression } from "../src/policy";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; batchSizes: number[]; preparedSql: string[] };

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
        return (statements: D1PreparedStatement[]) => {
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

describe("Authority v2 structural Batch resolution", () => {
  it("de-duplicates base Authority and resolves all Delegation chains set-wise", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_auth_perf_${suffix}`;
    const personId = `per_auth_perf_${suffix}`;
    const agentId = `agt_${suffix}`;
    const spaceId = `spc_auth_perf_${suffix}`;
    const applicationId = `app_auth_perf_${suffix}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authority performance", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_auth_perf_${suffix}`, spaceId, userId, "owner", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "Authority Performance User", now, now),
      db.prepare(`INSERT INTO application_model_access(
        application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`).bind(applicationId, "task", "write", "user", userId, now, now),
    ]);

    const model = await getRuntimeModel({ DB: db } as Bindings, "task");
    expect(model).not.toBeNull();
    if (!model) throw new Error("Task model missing");

    const direct: Principal = {
      type: "user",
      id: userId,
      clientId: applicationId,
      scopes: ["resources:read", "resources:write"],
      tokenId: `tok_direct_${suffix}`,
    };
    const represented: Principal = {
      ...direct,
      tokenId: `tok_agent_${suffix}`,
      actor: { type: "agent", id: agentId },
      purpose: "agent_execution",
    };

    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [] };
    const bindings = { DB: countedDatabase(db, counter) } as Bindings;
    const recordIds = Array.from({ length: 20 }, (_, index) => `rec_auth_perf_${suffix}_${index}`);

    const directDecisions = await requireModelAccessMany(
      bindings,
      direct,
      spaceId,
      recordIds.map((recordId) => ({
        model,
        required: "write" as const,
        selector: { recordId },
      })),
    );
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([1]);
    expect(counter.preparedSql).toHaveLength(1);
    expect((counter.preparedSql[0]!.match(/FROM space_people/g) ?? [])).toHaveLength(1);
    expect(directDecisions).toHaveLength(20);
    expect(directDecisions.every((decision) =>
      decision.policyIdentity.principalPersonId === personId && decision.policyIdentity.actorPersonId === personId
    )).toBe(true);

    const modelDelegationId = `dlg_auth_perf_model_${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at
      ) VALUES(?,'user',?,'agent',?,?,?,'user',?,?)`).bind(
        modelDelegationId,
        userId,
        agentId,
        applicationId,
        spaceId,
        userId,
        now,
      ),
      db.prepare(`INSERT INTO delegation_scopes(
        delegation_id,target_type,target_id,target_model_key,max_access
      ) VALUES(?,'model','task','task','write')`).bind(modelDelegationId),
    ]);

    counter.roundTrips = 0;
    counter.batchSizes = [];
    counter.preparedSql = [];
    const representedDecisions = await requireModelAccessMany(
      bindings,
      represented,
      spaceId,
      recordIds.map((recordId) => ({
        model,
        required: "write" as const,
        selector: { delegationId: modelDelegationId, recordId },
      })),
    );
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([2]);
    expect(counter.preparedSql).toHaveLength(2);
    expect(counter.preparedSql.some((sql) => sql.includes("WITH RECURSIVE chain"))).toBe(true);
    expect(counter.preparedSql.reduce(
      (count, sql) => count + (sql.match(/FROM space_people/g) ?? []).length,
      0,
    )).toBe(1);
    expect(representedDecisions.every((decision) =>
      decision.policyIdentity.principalPersonId === personId && decision.policyIdentity.actorPersonId === null
    )).toBe(true);

    const representedIdentity = {
      principalPersonId: representedDecisions[0]!.policyIdentity.principalPersonId,
      actorPersonId: representedDecisions[0]!.policyIdentity.actorPersonId,
    };
    await expect(requirePolicyExpression(
      bindings,
      represented,
      spaceId,
      { op: "neq", left: { $ref: "principal.personId" }, right: { value: null } },
      undefined,
      undefined,
      representedIdentity,
    )).resolves.toMatchObject({
      principal: { type: "user", id: userId, personId },
      actor: { type: "agent", id: agentId, personId: null },
    });
    await expect(requirePolicyExpression(
      bindings,
      represented,
      spaceId,
      { op: "neq", left: { $ref: "actor.personId" }, right: { value: null } },
      undefined,
      undefined,
      representedIdentity,
    )).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const recordDelegationStatements: D1PreparedStatement[] = [];
    const recordDelegationIds: string[] = [];
    recordIds.forEach((recordId, index) => {
      const delegationId = `dlg_auth_perf_record_${suffix}_${index}`;
      recordDelegationIds.push(delegationId);
      recordDelegationStatements.push(
        db.prepare(`INSERT INTO delegations(
          id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
          created_by_type,created_by_id,created_at
        ) VALUES(?,'user',?,'agent',?,?,?,'user',?,?)`).bind(
          delegationId,
          userId,
          agentId,
          applicationId,
          spaceId,
          userId,
          now,
        ),
        db.prepare(`INSERT INTO delegation_scopes(
          delegation_id,target_type,target_id,target_model_key,max_access
        ) VALUES(?,'record',?,'task','write')`).bind(delegationId, recordId),
      );
    });
    await db.batch(recordDelegationStatements);

    counter.roundTrips = 0;
    counter.batchSizes = [];
    counter.preparedSql = [];
    const recordScoped = await requireModelAccessMany(
      bindings,
      represented,
      spaceId,
      recordIds.map((recordId, index) => ({
        model,
        required: "write" as const,
        selector: { delegationId: recordDelegationIds[index], recordId },
      })),
    );
    expect(counter.roundTrips).toBe(1);
    expect(counter.batchSizes).toEqual([2]);
    expect(counter.preparedSql).toHaveLength(2);
    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(1);
    expect(recordScoped).toHaveLength(20);
  });
});
