import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { getPublishedModel } from "../src/model-registry";
import { compilePhysicalSchema } from "../src/physical-schema";

type TestEnv = { DB: D1Database };

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

type IndexListRow = {
  name: string;
};

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

async function assertPublishedModelPhysicalSchema(modelKey: string): Promise<void> {
  const db = (env as unknown as TestEnv).DB;
  const model = await getPublishedModel(bindings(), modelKey);
  if (!model) throw new Error(`Published model ${modelKey} is missing`);
  const plan = compilePhysicalSchema(model.definition);

  const tableInfo = await db.prepare(`PRAGMA table_info("${plan.tableName}")`).all<TableInfoRow>();
  expect(tableInfo.results.map((row) => [row.name, row.type, row.notnull, row.pk])).toEqual([
    ["record_id", "TEXT", 0, 1],
    ["space_id", "TEXT", 1, 0],
    ...plan.columns.map((column) => [column.fieldKey, column.sqlType, column.nullable ? 0 : 1, 0]),
  ]);

  const indexes = await db.prepare(`PRAGMA index_list("${plan.tableName}")`).all<IndexListRow>();
  const generatedIndexNames = indexes.results
    .map((row) => row.name)
    .filter((name) => name.startsWith(`idx_${plan.tableName}_`))
    .sort();
  expect(generatedIndexNames).toEqual(plan.indexes.map((index) => index.name).sort());
}

describe("Typed model storage baseline", () => {
  it("matches the Physical Schema Compiler for every built-in published model", async () => {
    for (const modelKey of ["task", "wish", "day_record", "event", "person_group"]) {
      await assertPublishedModelPhysicalSchema(modelKey);
    }
  });
});
