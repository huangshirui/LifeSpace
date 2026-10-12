import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type TestEnv = { DB: D1Database };

type PlanRow = { detail: string };

async function plan(sql: string, bindings: unknown[]): Promise<string> {
  const db = (env as unknown as TestEnv).DB;
  const result = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all<PlanRow>();
  return result.results.map((row) => row.detail).join("\n");
}

describe("Semantic Relation performance gates", () => {
  it("uses the source, target, and predicate indexes for bounded traversal", async () => {
    const source = await plan(
      `SELECT id FROM semantic_relations
       WHERE space_id=? AND source_model_key=? AND source_record_id=? AND predicate=?
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      ["spc_plan", "source_model", "rec_source", "relates_to", 50],
    );
    expect(source).toContain("idx_semantic_relations_source");

    const target = await plan(
      `SELECT id FROM semantic_relations
       WHERE space_id=? AND target_model_key=? AND target_record_id=? AND predicate=?
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      ["spc_plan", "target_model", "rec_target", "relates_to", 50],
    );
    expect(target).toContain("idx_semantic_relations_target");

    const predicate = await plan(
      `SELECT id FROM semantic_relations
       WHERE space_id=? AND predicate=?
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      ["spc_plan", "relates_to", 50],
    );
    expect(predicate).toContain("idx_semantic_relations_predicate");
  });

  it("keeps endpoint cleanup on the source and target composite indexes", async () => {
    const sourceDelete = await plan(
      `DELETE FROM semantic_relations
       WHERE space_id=? AND source_model_key=? AND source_record_id=?`,
      ["spc_plan", "source_model", "rec_source"],
    );
    expect(sourceDelete).toContain("idx_semantic_relations_source");

    const targetDelete = await plan(
      `DELETE FROM semantic_relations
       WHERE space_id=? AND target_model_key=? AND target_record_id=?`,
      ["spc_plan", "target_model", "rec_target"],
    );
    expect(targetDelete).toContain("idx_semantic_relations_target");
  });

  it("atomically cleans one thousand incoming/outgoing edges without leaving dangling rows", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_perf_${suffix}`;
    const spaceId = `spc_perf_${suffix}`;
    const endpointId = `rec_endpoint_${suffix}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(spaceId, "Relation perf", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO resource_records(
        id,space_id,model_key,model_version,data_json,version,
        created_by_type,created_by_id,created_by_entity_type,created_by_name_snapshot,created_at,
        updated_by_type,updated_by_id,updated_by_entity_type,updated_by_name_snapshot,updated_at,
        deleted_at,search_text,mutation_token
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .bind(
          endpointId, spaceId, "endpoint_model", 1, "{}", 1,
          "user", userId, "user", "Perf", now,
          "user", userId, "user", "Perf", now,
          null, "",
        ),
    ]);

    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const otherId = `rec_other_${index}_${suffix}`;
      statements.push(
        db.prepare(`INSERT INTO resource_records(
          id,space_id,model_key,model_version,data_json,version,
          created_by_type,created_by_id,created_by_entity_type,created_by_name_snapshot,created_at,
          updated_by_type,updated_by_id,updated_by_entity_type,updated_by_name_snapshot,updated_at,
          deleted_at,search_text,mutation_token
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
          .bind(
            otherId, spaceId, "other_model", 1, "{}", 1,
            "user", userId, "user", "Perf", now,
            "user", userId, "user", "Perf", now,
            null, "",
          ),
        db.prepare(`INSERT INTO semantic_relations(
          id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).bind(
          `rel_out_${index}_${suffix}`,
          spaceId,
          "endpoint_model",
          endpointId,
          "relates_to",
          "other_model",
          otherId,
          now,
        ),
        db.prepare(`INSERT INTO semantic_relations(
          id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).bind(
          `rel_in_${index}_${suffix}`,
          spaceId,
          "other_model",
          otherId,
          "relates_to",
          "endpoint_model",
          endpointId,
          now,
        ),
      );
    }
    for (let start = 0; start < statements.length; start += 100) {
      await db.batch(statements.slice(start, start + 100));
    }

    const changeId = `chg_perf_${suffix}`;
    await db.prepare(`INSERT INTO resource_changes(
      id,record_id,space_id,model_key,operation,action_key,version_before,version_after,
      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,bulk_id,
      changed_fields_json,field_changes_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      changeId,
      endpointId,
      spaceId,
      "endpoint_model",
      "delete",
      null,
      1,
      2,
      "user",
      userId,
      "user",
      userId,
      "app_perf",
      null,
      null,
      null,
      "[]",
      "[]",
      now,
    ).run();

    const remaining = await db.prepare(`SELECT COUNT(*) count FROM semantic_relations
      WHERE space_id=? AND (source_record_id=? OR target_record_id=?)`)
      .bind(spaceId, endpointId, endpointId).first<{ count: number }>();
    const evidence = await db.prepare(`SELECT COUNT(*) count FROM semantic_relation_changes
      WHERE space_id=? AND operation='endpoint_delete' AND source_resource_change_id=?`)
      .bind(spaceId, changeId).first<{ count: number }>();
    expect(Number(remaining?.count ?? -1)).toBe(0);
    expect(Number(evidence?.count ?? -1)).toBe(2000);
  });
});
