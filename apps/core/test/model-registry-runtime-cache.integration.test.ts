import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import {
  getRuntimeModel,
  invalidateRuntimeModelRegistry,
  validateDefinition,
} from "../src/model-registry";
import { countingDatabase, type DatabaseCost } from "./support/counting-database";

type TestEnv = { DB: D1Database };

function cost(): DatabaseCost {
  return { roundTrips: 0, rowsRead: 0, sql: [] };
}

describe("Runtime Model Registry cache", () => {
  it("resolves a newly published key after a warm isolate snapshot without taxing cache hits", async () => {
    const database = (env as unknown as TestEnv).DB;
    const measured = cost();
    const bindings = { DB: countingDatabase(database, measured) } as Bindings;
    invalidateRuntimeModelRegistry(bindings);

    const task = await getRuntimeModel(bindings, "task");
    expect(task?.key).toBe("task");

    measured.roundTrips = 0;
    measured.rowsRead = 0;
    measured.sql.length = 0;
    expect((await getRuntimeModel(bindings, "task"))?.key).toBe("task");
    expect(measured.roundTrips).toBe(0);

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const key = `cache_probe_${suffix}`;
    const definition = {
      definitionVersion: 1,
      key,
      display: { singular: "Cache probe", plural: "Cache probes" },
      fields: { name: { type: "string", required: true } },
      access: ["read", "write"],
    };
    const validation = await validateDefinition(definition);
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error("Cache probe definition must validate");

    const modelId = `mdl_cache_probe_${suffix}`;
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO model_definitions(
      id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
      published_by_type,published_by_id,published_by_name_snapshot,published_at
    ) VALUES(?,?,?,1,'published',1,?,?, 'initial','service','svc_cache_probe','Cache probe',?)`)
      .bind(modelId, key, key, JSON.stringify(validation.definition), validation.schemaHash, now).run();

    try {
      measured.roundTrips = 0;
      measured.rowsRead = 0;
      measured.sql.length = 0;

      const discovered = await getRuntimeModel(bindings, key);
      expect(discovered?.key).toBe(key);
      expect(discovered?.schemaHash).toBe(validation.schemaHash);
      expect(measured.roundTrips).toBe(1);
      expect(measured.sql.some((sql) => sql.includes("FROM model_definitions WHERE model_key=? AND state='published'"))).toBe(true);

      measured.roundTrips = 0;
      measured.rowsRead = 0;
      measured.sql.length = 0;
      expect((await getRuntimeModel(bindings, key))?.key).toBe(key);
      expect(measured.roundTrips).toBe(0);
    } finally {
      await database.prepare("DELETE FROM model_definitions WHERE id=?").bind(modelId).run();
      invalidateRuntimeModelRegistry(bindings);
    }
  });
});
