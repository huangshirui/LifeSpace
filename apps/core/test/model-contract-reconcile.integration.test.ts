import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { getOrCreateActiveModelContract } from "../src/model-contract-service";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

describe("Model Contract code-level reconciliation", () => {
  it("restores the generated contract without changing the registry revision", async () => {
    const active = await getOrCreateActiveModelContract(bindings());
    const db = (env as unknown as TestEnv).DB;
    const seed = crypto.randomUUID().replaceAll("-", "");
    const staleHash = `${seed}${seed}`;
    const staleId = `mct_${staleHash}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`INSERT INTO model_contract_revisions(
        id,contract_hash,manifest_json,openapi_json,json_schema_json,
        created_by_type,created_by_id,created_by_name_snapshot,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
        staleId,
        staleHash,
        JSON.stringify(active.manifest),
        JSON.stringify(active.openapi),
        JSON.stringify(active.jsonSchema),
        "service",
        "svc_stale_contract_test",
        "svc_stale_contract_test",
        now,
      ),
      db.prepare(`UPDATE model_contract_state SET active_contract_id=?,updated_at=? WHERE singleton=1`)
        .bind(staleId, now),
    ]);

    const reconciled = await getOrCreateActiveModelContract(bindings());
    expect(reconciled.id).toBe(active.id);
    expect(reconciled.hash).toBe(active.hash);
    expect(reconciled.registryRevision).toBe(active.registryRevision);

    const staleStillExists = await db.prepare("SELECT id FROM model_contract_revisions WHERE id=?")
      .bind(staleId).first<{ id: string }>();
    expect(staleStillExists?.id).toBe(staleId);
  });
});
