import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type TestEnv = { DB: D1Database };

describe("typed storage cleanup", () => {
  it("removes the intermediate generic JSON and scalar-index structures", async () => {
    const db = (env as unknown as TestEnv).DB;
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_index_values'")
      .all<{ name: string }>();
    expect(tables.results).toEqual([]);

    const columns = await db.prepare("SELECT name FROM pragma_table_info('resource_records')")
      .all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).not.toContain("data_json");
  });
});
