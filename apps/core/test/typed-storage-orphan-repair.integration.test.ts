import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type TestEnv = {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

function repairMigration(): D1Migration {
  const migration = (env as unknown as TestEnv).TEST_MIGRATIONS.find((entry) =>
    entry.name.startsWith("0024_remove_unrecoverable_pre_typed_orphans"),
  );
  if (!migration) throw new Error("0024 typed-orphan repair migration is missing");
  return migration;
}

describe("typed storage orphan repair", () => {
  it("removes unrecoverable proving-model envelopes and incoming record relations", async () => {
    const db = (env as unknown as TestEnv).DB;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const spaceId = `spc_orphan_${suffix}`;
    const orphanId = `rec_orphan_${suffix}`;
    const sourceId = `rec_source_${suffix}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, "Typed orphan repair", `usr_${suffix}`, now, now, "UTC"),
      db.prepare(`INSERT INTO resource_records(
        id,space_id,model_key,model_version,created_by_type,created_by_id,created_by_name_snapshot,
        updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        orphanId, spaceId, "task", 2, "user", `usr_${suffix}`, "Repair Test",
        "user", `usr_${suffix}`, "Repair Test", 1, now, now,
      ),
      db.prepare(`INSERT INTO resource_records(
        id,space_id,model_key,model_version,created_by_type,created_by_id,created_by_name_snapshot,
        updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        sourceId, spaceId, "task", 2, "user", `usr_${suffix}`, "Repair Test",
        "user", `usr_${suffix}`, "Repair Test", 1, now, now,
      ),
      db.prepare(`INSERT INTO mdl_task(record_id,space_id,name,status)
        VALUES(?,?,?,?)`).bind(sourceId, spaceId, "Valid source task", "pending"),
      db.prepare(`INSERT INTO resource_relations(
        source_record_id,source_space_id,source_model_key,field_key,ordinal,target_type,target_person_id,target_record_id
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
        sourceId, spaceId, "task", "repairTarget", 0, "record", null, orphanId,
      ),
    ]);

    expect(await db.prepare("SELECT id FROM resource_records WHERE id=?").bind(orphanId).first()).not.toBeNull();
    expect(await db.prepare("SELECT source_record_id FROM resource_relations WHERE target_record_id=?").bind(orphanId).first()).not.toBeNull();

    const migration = repairMigration();
    for (const query of migration.queries) await db.prepare(query).run();

    expect(await db.prepare("SELECT id FROM resource_records WHERE id=?").bind(orphanId).first()).toBeNull();
    expect(await db.prepare("SELECT source_record_id FROM resource_relations WHERE target_record_id=?").bind(orphanId).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM resource_records WHERE id=?").bind(sourceId).first()).not.toBeNull();
    expect(await db.prepare("SELECT record_id FROM mdl_task WHERE record_id=?").bind(sourceId).first()).not.toBeNull();
  });
});
