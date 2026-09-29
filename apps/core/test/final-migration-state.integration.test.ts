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

  it("keeps only the generic Delegation persistence shape after schema 47", async () => {
    const db = (env as unknown as TestEnv).DB;
    const tables = await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'delegations','delegation_scopes','agent_delegations','agent_delegation_models','agent_delegation_scopes'
      ) ORDER BY name`).all<{ name: string }>();

    expect(tables.results.map((row) => row.name)).toEqual([
      "delegation_scopes",
      "delegations",
    ]);

    const columns = await db.prepare("PRAGMA table_info(delegations)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "principal_type",
      "principal_id",
      "actor_type",
      "actor_id",
      "application_id",
      "source_space_id",
    ]));
  });

  it("reports the latest Core schema version", async () => {
    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("47");
  });
});
