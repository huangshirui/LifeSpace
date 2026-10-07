import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type TestEnv = { DB: D1Database };

describe("final migration state", () => {
  it("does not retain platform-bootstrap application model access after convergence", async () => {
    const db = (env as unknown as TestEnv).DB;
    const rows = await db.prepare(`SELECT application_id,model_key,max_access,created_by_type,created_by_id
      FROM application_model_access
      WHERE created_by_type='service'
        AND created_by_id='svc_lifespace_bootstrap'
      ORDER BY application_id,model_key`).all<Record<string, unknown>>();

    expect(rows.results).toEqual([]);
  });

  it("keeps resource_records in place and adds exact Entity Type audit columns", async () => {
    const db = (env as unknown as TestEnv).DB;
    const columns = await db.prepare("PRAGMA table_info(resource_records)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "created_by_type",
      "created_by_entity_type",
      "created_by_id",
      "updated_by_type",
      "updated_by_entity_type",
      "updated_by_id",
    ]));

    const indexes = await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='resource_records' ORDER BY name`).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "idx_resource_records_model",
      "idx_resource_records_space_model",
      "idx_resource_records_space_model_updated",
    ]));

    const staleExactTypes = await db.prepare(`SELECT COUNT(*) AS count FROM resource_records
      WHERE created_by_entity_type IS NULL OR updated_by_entity_type IS NULL`).first<{ count: number }>();
    expect(Number(staleExactTypes?.count ?? -1)).toBe(0);
  });

  it("keeps generic Delegation persistence and bounded chain evidence after schema 48", async () => {
    const db = (env as unknown as TestEnv).DB;
    const tables = await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'delegations','delegation_scopes','resource_change_delegations',
        'agent_delegations','agent_delegation_models','agent_delegation_scopes'
      ) ORDER BY name`).all<{ name: string }>();

    expect(tables.results.map((row) => row.name)).toEqual([
      "delegation_scopes",
      "delegations",
      "resource_change_delegations",
    ]);

    const columns = await db.prepare("PRAGMA table_info(delegations)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "principal_type",
      "principal_id",
      "actor_type",
      "actor_id",
      "application_id",
      "source_space_id",
      "parent_delegation_id",
      "remaining_redelegation_depth",
    ]));

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
    expect(row?.value).toBe("52");
  });
});