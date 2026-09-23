import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource, deleteGenericResource, updateGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Counter = { roundTrips: number; maxBindings: number };
const statementTargets = new WeakMap<object, D1PreparedStatement>();

function countedStatement(statement: D1PreparedStatement, counter: Counter): D1PreparedStatement {
  const proxy = new Proxy(statement as object, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) => {
          counter.maxBindings = Math.max(counter.maxBindings, values.length);
          return countedStatement(statement.bind(...values), counter);
        };
      }
      if (property === "first" || property === "all" || property === "run" || property === "raw") {
        return (...args: unknown[]) => {
          counter.roundTrips += 1;
          const fn = (statement as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[property];
          return fn.apply(statement, args);
        };
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
      if (property === "prepare") return (query: string) => countedStatement(database.prepare(query), counter);
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counter.roundTrips += 1;
          return database.batch(statements.map((statement) => statementTargets.get(statement as unknown as object) ?? statement));
        };
      }
      const value = Reflect.get(target, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
  }) as D1Database;
}

const actor: Principal = {
  type: "user",
  id: "usr_change_perf",
  clientId: "change-perf-app",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_change_perf",
};

describe("Governed Change detail cost", () => {
  it("keeps mutation round trips bounded and records compact representative detail", async () => {
    const realDb = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const spaceId = `spc_change_perf_${suffix}`;
    const now = new Date().toISOString();
    await realDb.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Change Performance", actor.id, now, now, "UTC").run();

    const model = await getPublishedModel({ DB: realDb } as Bindings, "task");
    if (!model) throw new Error("Task model missing");

    const counter: Counter = { roundTrips: 0, maxBindings: 0 };
    const db = countedDatabase(realDb, counter);
    const bindings = { DB: db } as Bindings;

    counter.roundTrips = 0;
    const created = await createGenericResource(bindings, actor, spaceId, model, {
      name: "Measure Change detail",
      description: "Representative payload",
    });
    const createRoundTrips = counter.roundTrips;

    counter.roundTrips = 0;
    const updated = await updateGenericResource(bindings, actor, spaceId, model, created.id, 1, {
      description: "Representative payload updated",
    });
    const updateRoundTrips = counter.roundTrips;

    counter.roundTrips = 0;
    await deleteGenericResource(bindings, actor, spaceId, model, created.id, updated.version);
    const deleteRoundTrips = counter.roundTrips;

    const rows = await realDb.prepare(`SELECT operation,
        length(changed_fields_json) changed_bytes,
        length(field_changes_json) detail_bytes
      FROM resource_changes WHERE record_id=? ORDER BY version_after`)
      .bind(created.id)
      .all<{ operation: string; changed_bytes: number; detail_bytes: number }>();

    expect(createRoundTrips).toBeLessThanOrEqual(2);
    expect(updateRoundTrips).toBeLessThanOrEqual(3);
    expect(deleteRoundTrips).toBeLessThanOrEqual(3);
    expect(counter.maxBindings).toBeLessThanOrEqual(100);
    expect(rows.results).toHaveLength(3);
    expect(Math.max(...rows.results.map((row) => row.detail_bytes))).toBeLessThan(16 * 1024);

    console.log("GOVERNED_CHANGE_DETAIL_COST", JSON.stringify({
      environment: "Cloudflare Vitest local D1; wall time omitted",
      roundTrips: { create: createRoundTrips, update: updateRoundTrips, delete: deleteRoundTrips },
      storedBytes: rows.results,
      maxBindings: counter.maxBindings,
    }));
  });
});
