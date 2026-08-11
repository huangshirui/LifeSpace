CREATE TABLE resource_records (
  id TEXT PRIMARY KEY CHECK(id GLOB 'rec_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  model_key TEXT NOT NULL,
  model_version INTEGER NOT NULL CHECK(model_version >= 1),
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user','service','device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  updated_by_type TEXT NOT NULL CHECK(updated_by_type IN ('user','service','device')),
  updated_by_id TEXT NOT NULL,
  updated_by_name_snapshot TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  mutation_token TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  FOREIGN KEY(model_key, model_version) REFERENCES model_definitions(model_key, version)
);

CREATE INDEX idx_resource_records_space_model
  ON resource_records(space_id, model_key, deleted_at, created_at DESC, id DESC);

CREATE INDEX idx_resource_records_model
  ON resource_records(model_key, deleted_at, updated_at DESC, id DESC);

CREATE TABLE resource_relations (
  source_record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  source_model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
  target_type TEXT NOT NULL CHECK(target_type IN ('person','record')),
  target_person_id TEXT REFERENCES space_people(id),
  target_record_id TEXT REFERENCES resource_records(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_record_id, field_key, ordinal),
  CHECK(
    (target_type='person' AND target_person_id IS NOT NULL AND target_record_id IS NULL)
    OR
    (target_type='record' AND target_record_id IS NOT NULL AND target_person_id IS NULL)
  )
);

CREATE INDEX idx_resource_relations_person
  ON resource_relations(target_person_id, source_model_key, field_key)
  WHERE target_person_id IS NOT NULL;

CREATE INDEX idx_resource_relations_record
  ON resource_relations(target_record_id, source_model_key, field_key)
  WHERE target_record_id IS NOT NULL;

CREATE TABLE resource_index_values (
  record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('text','number','date','datetime','boolean')),
  text_value TEXT,
  number_value REAL,
  boolean_value INTEGER CHECK(boolean_value IS NULL OR boolean_value IN (0,1)),
  PRIMARY KEY(record_id, field_key),
  CHECK(
    (value_type IN ('text','date','datetime') AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
    OR
    (value_type='number' AND text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
    OR
    (value_type='boolean' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)
  )
);

CREATE INDEX idx_resource_index_text
  ON resource_index_values(space_id, model_key, field_key, text_value, record_id)
  WHERE text_value IS NOT NULL;

CREATE INDEX idx_resource_index_number
  ON resource_index_values(space_id, model_key, field_key, number_value, record_id)
  WHERE number_value IS NOT NULL;

UPDATE schema_metadata
SET value='11'
WHERE key='schema_version';
