import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

type TestEnv = {
  DB: D1Database;
};

describe("final migration state", () => {
  it("does not retain platform-bootstrap application model access after convergence", async () => {
    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare(`SELECT COUNT(*) count FROM application_model_access
      WHERE application_id='app_platform_bootstrap'`).first<{ count: number }>();
    expect(Number(row?.count ?? -1)).toBe(0);
  });

  it("keeps resource_records in place and adds exact Entity Type audit columns", async () => {
    const db = (env as unknown as TestEnv).DB;
    const columns = await db.prepare("PRAGMA table_info(resource_records)").all<{ name: string }>();
    expect(new Set(columns.results.map((row) => row.name))).toEqual(expect.objectContaining(new Set([
      "created_by_entity_type",
      "updated_by_entity_type",
    ])));
  });

  it("keeps generic Delegation persistence and bounded chain evidence after schema 48", async () => {
    const db = (env as unknown as TestEnv).DB;
    const delegationColumns = await db.prepare("PRAGMA table_info(delegations)").all<{ name: string }>();
    expect(new Set(delegationColumns.results.map((row) => row.name))).toEqual(expect.objectContaining(new Set([
      "principal_type",
      "principal_id",
      "actor_type",
      "actor_id",
      "parent_delegation_id",
      "remaining_redelegation_depth",
    ])));

    const evidenceColumns = await db.prepare("PRAGMA table_info(resource_change_delegations)").all<{ name: string }>();
    expect(evidenceColumns.results.map((row) => row.name)).toEqual([
      "change_id",
      "delegation_id",
      "chain_position",
    ]);
  });

  it("reports the latest Core schema version", async () => {
    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("54");
  });
});