import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = (n) => readFileSync(new URL("../migrations/" + n, import.meta.url), "utf8");
function legacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO schema_metadata VALUES('schema_version','76');");
  db.exec(migration("0077_mcp_server_registry.sql"));
  return db;
}
function seed(db, key, status, draft, published) {
  const id = "mcp_" + key;
  db.prepare(`INSERT INTO mcp_server_definitions(
    id,server_key,display_name,description,status,draft_json,draft_revision,published_revision,
    created_by_user_id,updated_by_user_id,created_at,updated_at,published_at,withdrawn_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,id,key,"legacy description",status,JSON.stringify(draft),2,published ? 1 : null,
    "usr_creator","usr_updater","created","updated",published ? "published" : null,null,
  );
  if (published) {
    db.prepare(`INSERT INTO mcp_server_publications(
      server_id,revision,manifest_json,manifest_hash,published_at,published_by_user_id
    ) VALUES(?,?,?,?,?,?)`).run(id,1,JSON.stringify(published),"hash","published","usr_creator");
  }
  return id;
}
test("schema 78 keeps effective published selections, not subsequent unpublished draft edits", () => {
  const db=legacyDb();
  const id=seed(db,"active","published",{
    models:[{modelKey:"task",operations:["delete"]}],
  },{
    serverId:"mcp_active",path:"/mcp/mcp_active",models:[
      {modelKey:"task",modelVersion:12,schemaHash:"hash",operations:["query","get"]},
    ],
    resources:[{resourceKey:"person_directory",authorityResourceType:"person_directory",operations:["list"]}],
  });
  db.exec(migration("0078_mcp_server_simple_config.sql"));
  const row=db.prepare("SELECT * FROM mcp_server_definitions WHERE id=?").get(id);
  assert.equal(row.enabled,1);
  assert.equal(row.revision,2);
  assert.equal(row.display_name,"active");
  assert.equal(row.created_by_user_id,"usr_creator");
  assert.deepEqual(JSON.parse(row.config_json),{
    models:[{modelKey:"task",operations:["query","get"]}],
    resources:[{resourceKey:"person_directory",operations:["list"]}],
  });
  assert.equal(db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get().value,"78");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='mcp_server_publications'").get(),undefined);
  db.close();
});

test("schema 78 preserves draft and withdrawn Server identities as disabled configs", () => {
  const db=legacyDb();
  const draft={models:[{modelKey:"task",operations:["query"]}]};
  const pending=seed(db,"pending","draft",draft,null);
  const withdrawn=seed(db,"withdrawn","withdrawn",draft,{
    models:[{modelKey:"task",operations:["create"]}],
  });
  db.exec(migration("0078_mcp_server_simple_config.sql"));
  for (const id of [pending,withdrawn]) {
    const row=db.prepare("SELECT * FROM mcp_server_definitions WHERE id=?").get(id);
    assert.equal(row.enabled,0);
    assert.deepEqual(JSON.parse(row.config_json),draft);
    assert.equal(row.revision,2);
  }
  assert.deepEqual(db.prepare("PRAGMA table_info(mcp_server_definitions)").all()
    .map((x)=>x.name),["id","display_name","description","enabled","config_json","revision",
      "created_by_user_id","updated_by_user_id","created_at","updated_at"]);
  db.close();
});
