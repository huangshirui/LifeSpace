import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const sql = readFileSync(new URL("../migrations/0079_activity_lifecycle.sql", import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../model-catalog/baseline-models.json", import.meta.url), "utf8"));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const previous = structuredClone(catalog.activity);
delete previous.fields.status;
delete previous.defaults;
delete previous.actions;
previous.query.filterable = previous.query.filterable.filter(f => f !== "status");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_metadata VALUES('schema_version','78');
    CREATE TABLE spaces(id TEXT PRIMARY KEY);
    INSERT INTO spaces VALUES('spc_example');
    CREATE TABLE model_definitions(id TEXT PRIMARY KEY, model_key TEXT, route_segment TEXT,
      version INTEGER, state TEXT, definition_version INTEGER, definition_json TEXT,
      schema_hash TEXT, compatibility TEXT, published_by_type TEXT, published_by_id TEXT,
      published_by_name_snapshot TEXT, published_at TEXT, superseded_at TEXT,
      UNIQUE(model_key,version));
    CREATE TABLE resource_records(id TEXT PRIMARY KEY, model_key TEXT, model_version INTEGER,
      space_id TEXT, version INTEGER, icon_json TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE mdl_activity(record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL, description TEXT,
      startDate TEXT, endDate TEXT, UNIQUE(space_id,record_id));
    CREATE TABLE resource_relations(source_id TEXT REFERENCES resource_records(id), target_id TEXT REFERENCES resource_records(id));
    CREATE TABLE model_registry_state(singleton INTEGER PRIMARY KEY, revision INTEGER, mutation_token TEXT, updated_at TEXT);
    INSERT INTO model_registry_state VALUES(1,12,'old','before');
    CREATE TABLE model_contract_state(revision TEXT);
    INSERT INTO model_contract_state VALUES('old');
    INSERT INTO resource_records VALUES
      ('past','activity',2,'spc_example',5,'{"type":"emoji","value":"⚽"}',NULL,'before'),
      ('future','activity',2,'spc_example',2,NULL,NULL,'before'),
      ('deleted','activity',2,'spc_example',7,NULL,'deleted','before'),
      ('other','task',10,'spc_example',1,NULL,NULL,'before');
    INSERT INTO mdl_activity VALUES
      ('past','spc_example','Past','description','2020-01-01','2020-01-02'),
      ('future','spc_example','Future',NULL,'2035-01-01',NULL),
      ('deleted','spc_example','Deleted',NULL,NULL,NULL);
    INSERT INTO resource_relations VALUES('past','other');
  `);
  db.prepare(`INSERT INTO model_definitions(id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility)
    VALUES('old','activity','activity',2,'published',1,?,?,'compatible')`).run(JSON.stringify(canonical(previous)), hash(previous));
  return db;
}

test("schema 79 backfills real v2 records without inventing completion or changing historical identity", () => {
  const db = fixture();
  try {
    assert.equal(hash(previous), "4fc8e1508b90e26f69ce5612d5291250bf87b5032431df4f54dfb15ef896c67c");
    const before = db.prepare("SELECT * FROM mdl_activity ORDER BY record_id").all();
    const records = db.prepare("SELECT * FROM resource_records ORDER BY id").all();
    const relations = db.prepare("SELECT * FROM resource_relations").all();
    db.exec(sql);
    assert.deepEqual(db.prepare("SELECT * FROM mdl_activity ORDER BY record_id").all().map(row => {
      assert.equal(row.status,"active"); delete row.status; return row;
    }), before);
    assert.deepEqual(db.prepare("SELECT * FROM resource_records ORDER BY id").all(), records.map(row => {
      if (row.model_key === "activity") row.model_version=3; return row;
    }));
    assert.deepEqual(db.prepare("SELECT * FROM resource_relations").all(),relations);
    const old = db.prepare("SELECT * FROM model_definitions WHERE id='old'").get();
    assert.equal(old.state,"superseded");
    assert.deepEqual(JSON.parse(old.definition_json),previous);
    const published = db.prepare("SELECT * FROM model_definitions WHERE state='published'").get();
    assert.equal(published.version,3);
    assert.equal(published.schema_hash,hash(catalog.activity));
    assert.deepEqual(JSON.parse(published.definition_json),catalog.activity);
    assert.equal(db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get().value,"79");
    assert.equal(db.prepare("SELECT revision FROM model_registry_state").get().revision,13);
    assert.equal(db.prepare("SELECT count(*) AS n FROM model_contract_state").get().n,0);
    assert.ok(db.prepare("PRAGMA index_list(mdl_activity)").all().some(row => row.name==="idx_mdl_activity_status"));
    assert.throws(() => db.exec("UPDATE mdl_activity SET status='unknown'"), /CHECK constraint failed/);
    assert.throws(() => db.exec("UPDATE mdl_activity SET status=NULL"), /NOT NULL constraint failed/);
    db.exec("INSERT INTO resource_records(id,model_key,model_version,space_id,version) VALUES('legacy','activity',2,'spc_example',1); INSERT INTO mdl_activity(record_id,space_id,name) VALUES('legacy','spc_example','Legacy insert');");
    assert.equal(db.prepare("SELECT status FROM mdl_activity WHERE record_id='legacy'").get().status,"active");
  } finally { db.close(); }
});

test("schema 79 refuses a divergent v2 hash or unmatched storage count before mutating Activity", () => {
  for (const mutation of ["UPDATE model_definitions SET schema_hash='wrong'", "DELETE FROM mdl_activity WHERE record_id='past'"]) {
    const db=fixture();
    try {
      db.exec(mutation);
      assert.throws(() => db.exec(sql), /CHECK constraint failed/);
      assert.equal(db.prepare("SELECT state FROM model_definitions WHERE id='old'").get().state,"published");
      assert.ok(!db.prepare("PRAGMA table_info(mdl_activity)").all().some(row => row.name==="status"));
    } finally { db.close(); }
  }
});
