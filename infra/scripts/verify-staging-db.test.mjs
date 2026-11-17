import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { decodeSqlRows, orphanEnvelopeSql, verifySchemaInventory, verifyTypedEnvelopes } from "./verify-staging-db.mjs";

const models = ["task","wish","day_record","event","person_group"];
function oldSql(model) {
  return `SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,
      r.created_by_type,r.created_by_id,r.created_at,r.updated_at,r.deleted_at
    FROM resource_records r
    LEFT JOIN mdl_${model} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE r.model_key='${model}' AND m.record_id IS NULL
    ORDER BY r.created_at,r.id LIMIT 20`;
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE resource_records(
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, model_key TEXT NOT NULL,
    model_version INTEGER NOT NULL, version INTEGER NOT NULL,
    created_by_type TEXT, created_by_id TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
  ); CREATE INDEX idx_resource_records_model ON resource_records(model_key,deleted_at,updated_at DESC,id DESC);`);
  for (const model of models) db.exec(`CREATE TABLE mdl_${model}(
    record_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, UNIQUE(space_id,record_id)
  );`);
  const insert = db.prepare("INSERT INTO resource_records VALUES(?,?,?,1,1,'user','fixture','2026-01-01','2026-01-01',?)");
  const row = (model,id,space="a",deleted=null,typedSpace=space) => {
    insert.run(id,space,model,deleted);
    if(typedSpace!==null) db.prepare(`INSERT INTO mdl_${model} VALUES(?,?)`).run(id,typedSpace);
  };
  return {db,row,query:sql=>db.prepare(sql).all()};
}
test("anti-join preserves complete bounded diagnostics for all five models, including deleted and wrong-Space envelopes", () => {
  const {db,row,query}=fixture();
  try {
    for (const model of models) {
      row(model,model+"-good");
      row(model,model+"-deleted-good","a","2026-02-01");
    }
    assert.doesNotThrow(()=>verifyTypedEnvelopes(query));
    for (const model of models) {
      row(model,model+"-missing","a",null,null);
      row(model,model+"-wrong-space","a",null,"b");
      row(model,model+"-deleted-missing","a","2026-02-01",null);
      for(let n=0;n<25;n++)row(model,model+"-z"+String(n).padStart(2,"0"),"a",null,null);
      const actual=query(orphanEnvelopeSql(model));
      assert.deepEqual(actual,query(oldSql(model)));
      assert.equal(actual.length,20);
      assert.ok(actual.some(x=>x.id===model+"-wrong-space"));
      assert.ok(actual.some(x=>x.id===model+"-deleted-missing"));
    }
    assert.throws(()=>verifyTypedEnvelopes(query),/task resources without typed rows/u);
    assert.throws(()=>orphanEnvelopeSql("unknown"),/Unsupported proving model/u);
  } finally {db.close();}
});
test("one sqlite_master scan retains required table, trigger type and retired table checks", () => {
  const db=new DatabaseSync(":memory:");
  try {
    const tables=["resource_records","resource_relations","mdl_task","mdl_wish","mdl_day_record","mdl_event","mdl_person_group","mdl_anniversary","mdl_activity","mdl_goal","mdl_person_profile","mdl_habit","temporal_occurrences","model_definitions","application_model_access","model_contract_revisions","model_contract_state","model_definition_drafts","space_person_names","space_person_changes","space_person_change_delegations"];
    const triggers=["finalize_claimed_ai_model_proposal_after_publication","trg_space_people_advance_version","trg_space_person_change_validate","trg_space_person_change_delegation_consume_single_use"];
    for(const table of tables)db.exec(`CREATE TABLE ${table}(id TEXT);`);
    for(const trigger of triggers)db.exec(`CREATE TRIGGER ${trigger} AFTER INSERT ON resource_records BEGIN SELECT 1; END;`);
    let calls=0;
    const run=sql=>{calls++;return db.prepare(sql).all();};
    verifySchemaInventory(run);
    assert.equal(calls,1);
    db.exec("DROP TRIGGER trg_space_person_change_validate; CREATE TABLE trg_space_person_change_validate(id TEXT);");
    assert.throws(()=>verifySchemaInventory(run),/Required trigger trg_space_person_change_validate is missing/u);
    db.exec("DROP TABLE trg_space_person_change_validate; CREATE TRIGGER trg_space_person_change_validate AFTER INSERT ON resource_records BEGIN SELECT 1; END;");
    db.exec("CREATE TABLE tasks(id TEXT);");
    assert.throws(()=>verifySchemaInventory(run),/Retired table tasks still exists/u);
    db.exec("DROP TABLE tasks; DROP TABLE mdl_task;");
    assert.throws(()=>verifySchemaInventory(run),/Required platform table mdl_task is missing/u);
  } finally {db.close();}
});
test("missing or failed Wrangler output cannot pass an empty orphan check", () => {
  assert.deepEqual(decodeSqlRows('[{"success":true,"results":[]}]'),[]);
  assert.deepEqual(decodeSqlRows('{"result":{"results":[{"id":"fixture"}]}}'),[{id:"fixture"}]);
  assert.throws(()=>decodeSqlRows('[]'),/did not return a staging D1 result array/u);
  assert.throws(()=>decodeSqlRows('{"success":true}'),/did not return a staging D1 result array/u);
  assert.throws(()=>decodeSqlRows('[{"results":[]},{"success":false}]'),/Staging D1 query failed/u);
});
