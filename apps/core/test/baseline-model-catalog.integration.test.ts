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
  version: number;
  definition_json: string;
  schema_hash: string;
  compatibility: string;
};

type HistoricalDefinitionRow = {
  version: number;
  state: string;
  definition_json: string;
  schema_hash: string;
};

const BASELINE_MODELS = [
  TASK_MODEL_DEFINITION,
  WISH_MODEL_DEFINITION,
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
] as const;

const RELEASE_HISTORY = Object.freeze({
  task: Object.freeze({ previousVersion: 6, previousHash: "1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837", previousRoute: "tasks", currentVersion: 7 }),
  wish: Object.freeze({ previousVersion: 6, previousHash: "4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3", previousRoute: "wishes", currentVersion: 7 }),
  day_record: Object.freeze({ previousVersion: 3, previousHash: "7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa", previousRoute: "day-records", currentVersion: 4 }),
  event: Object.freeze({ previousVersion: 4, previousHash: "66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4", previousRoute: "events", currentVersion: 5 }),
});

describe("canonical baseline Model Catalog", () => {
  it("matches the published Registry produced by a fresh migration chain", async () => {
    const db = (env as unknown as TestEnv).DB;
    const columns = await db.prepare("SELECT name FROM pragma_table_info('model_definitions')").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("route_segment");

    for (const canonical of BASELINE_MODELS) {
      const expected = await validateDefinition(canonical);
      expect(expected.valid, `${canonical.key} canonical definition must validate`).toBe(true);
      if (!expected.valid) continue;

      const release = RELEASE_HISTORY[canonical.key as keyof typeof RELEASE_HISTORY];
      const row = await db.prepare(`SELECT model_key,route_segment,version,definition_json,schema_hash,compatibility
          FROM model_definitions
          WHERE model_key=? AND state='published'`)
        .bind(canonical.key)
        .first<PublishedDefinitionRow>();

      expect(row, `${canonical.key} must have exactly one current published definition`).not.toBeNull();
      if (!row) continue;

      expect(row.model_key).toBe(canonical.key);
      expect(row.route_segment).toBe(canonical.key);
      expect(row.version).toBe(release.currentVersion);
      expect(row.schema_hash).toBe(expected.schemaHash);
      expect(row.compatibility).toBe("breaking");
      expect(JSON.parse(row.definition_json)).toEqual(expected.definition);
    }
  });

  it("keeps the pre-0.32 route-bearing versions immutable as superseded evidence", async () => {
    const db = (env as unknown as TestEnv).DB;

    for (const canonical of BASELINE_MODELS) {
      const release = RELEASE_HISTORY[canonical.key as keyof typeof RELEASE_HISTORY];
      const historical = await db.prepare(`SELECT version,state,definition_json,schema_hash
          FROM model_definitions
          WHERE model_key=? AND version=? AND schema_hash=?`)
        .bind(canonical.key, release.previousVersion, release.previousHash)
        .first<HistoricalDefinitionRow>();

      expect(historical, `${canonical.key} pre-0.32 version must remain stored`).not.toBeNull();
      if (!historical) continue;

      expect(historical.state).toBe("superseded");
      expect(historical.version).toBe(release.previousVersion);
      expect(historical.schema_hash).toBe(release.previousHash);
      const stored = JSON.parse(historical.definition_json) as { key?: string; route?: string };
      expect(stored.key).toBe(canonical.key);
      expect(stored.route).toBe(release.previousRoute);
    }
  });
});
