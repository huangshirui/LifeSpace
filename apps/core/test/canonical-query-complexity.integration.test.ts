import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { queryCanonicalResources, type CanonicalFilter } from "../src/canonical-query";
import type { Bindings, Principal } from "../src/env";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_canonical_query_complexity",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read"],
  tokenId: "tok_canonical_query_complexity",
};

function repeatedStatusFilter(count: number): CanonicalFilter {
  return {
    and: Array.from({ length: count }, () => ({
      field: "status",
      op: "eq",
      value: "pending",
    })),
  };
}

describe("Canonical Typed Query execution complexity", () => {
  it("allows the 100-binding boundary and rejects a query that would exceed it", async () => {
    const model = await getPublishedModel(bindings(), "task");
    if (!model) throw new Error("bootstrap Task model is missing");

    const atBudget = await queryCanonicalResources(
      bindings(),
      actor,
      "spc_canonical_query_complexity",
      model,
      { filter: repeatedStatusFilter(97) },
    );
    expect(atBudget.items).toEqual([]);
    expect(atBudget.nextCursor).toBeNull();

    await expect(queryCanonicalResources(
      bindings(),
      actor,
      "spc_canonical_query_complexity",
      model,
      { filter: repeatedStatusFilter(98) },
    )).rejects.toMatchObject({
      code: "INVALID_QUERY",
      status: 400,
      message: "Canonical Query exceeds the execution complexity budget",
    });
  });

  it("reuses an already-authorized actor Person for the me alias without another Space Person lookup", async () => {
    const db = (env as unknown as TestEnv).DB;
    const model = await getPublishedModel({ DB: db } as Bindings, "task");
    if (!model) throw new Error("bootstrap Task model is missing");

    let personLookups = 0;
    const countedDb = new Proxy(db as object, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM space_people")) personLookups += 1;
            return db.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, db);
        return typeof value === "function" ? value.bind(db) : value;
      },
    }) as D1Database;

    const result = await queryCanonicalResources(
      { DB: countedDb } as Bindings,
      actor,
      "spc_canonical_query_context",
      model,
      { filter: { field: "assigneePersonIds", op: "contains", value: "me" } },
      "per_authorized_actor",
    );

    expect(result.items).toEqual([]);
    expect(personLookups).toBe(0);
  });
});
