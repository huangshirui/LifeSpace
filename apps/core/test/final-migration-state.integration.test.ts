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

  it("reports the latest Core schema version", async () => {
    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
    expect(row?.value).toBe("46");
  });
});
