import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
} from "../src/builtin-models";
import { validateDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

type PublishedDefinitionRow = {
  model_key: string;
  route_segment: string;
  definition_json: string;
  schema_hash: string;
};

const BASELINE_MODELS = [
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
] as const;

describe("canonical baseline Model Catalog", () => {
  it("matches the published Registry produced by a fresh migration chain", async () => {
    const db = (env as unknown as TestEnv).DB;

    for (const canonical of BASELINE_MODELS) {
      const expected = await validateDefinition(canonical);
      expect(expected.valid, `${canonical.key} canonical definition must validate`).toBe(true);
      if (!expected.valid) continue;

      const row = await db.prepare(`SELECT model_key,route_segment,definition_json,schema_hash
          FROM model_definitions
          WHERE model_key=? AND state='published'`)
        .bind(canonical.key)
        .first<PublishedDefinitionRow>();

      expect(row, `${canonical.key} must have exactly one current published definition`).not.toBeNull();
      if (!row) continue;

      expect(row.model_key).toBe(canonical.key);
      expect(row.route_segment).toBe(canonical.route);
      expect(row.schema_hash).toBe(expected.schemaHash);
      expect(JSON.parse(row.definition_json)).toEqual(expected.definition);
    }
  });
});
