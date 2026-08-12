CREATE TABLE model_registry_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  mutation_token TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO model_registry_state(singleton,revision,mutation_token)
VALUES(1,0,NULL);

CREATE TABLE model_contract_revisions (
  id TEXT PRIMARY KEY CHECK(id GLOB 'mct_*'),
  contract_hash TEXT NOT NULL UNIQUE CHECK(length(contract_hash)=64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  openapi_json TEXT NOT NULL CHECK(json_valid(openapi_json)),
  json_schema_json TEXT NOT NULL CHECK(json_valid(json_schema_json)),
  created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user','service','device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE model_contract_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  active_contract_id TEXT NOT NULL REFERENCES model_contract_revisions(id),
  registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

UPDATE schema_metadata
SET value='13'
WHERE key='schema_version';
