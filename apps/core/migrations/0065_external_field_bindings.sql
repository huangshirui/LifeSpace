-- External Provider field identity is independent from the replaceable latest
-- schema snapshot. Keep sourceFieldId -> LifeSpace field key bindings durable so
-- Provider rename/delete/recreate cannot silently change public Record keys.
CREATE TABLE external_field_bindings (
  model_key TEXT NOT NULL REFERENCES external_models(model_key) ON DELETE CASCADE,
  source_field_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(model_key, source_field_id),
  UNIQUE(model_key, field_key)
);

CREATE INDEX idx_external_field_bindings_key
ON external_field_bindings(model_key, field_key);

UPDATE schema_metadata SET value='65' WHERE key='schema_version';
