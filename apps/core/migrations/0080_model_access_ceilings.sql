-- Core Schema 80: sparse, current-state Model Access Ceiling (#589).
-- No rows are backfilled; absence means inherit. V1 permits User only.
-- No Model Registry or immutable Model Contract change.
CREATE TABLE model_access_ceilings (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  entity_type TEXT NOT NULL CHECK (entity_type = 'user'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  model_key TEXT NOT NULL CHECK (length(model_key) > 0),
  max_access TEXT NOT NULL CHECK (max_access IN ('none','read','write','manage')),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, entity_type, entity_id, model_key)
) WITHOUT ROWID;
-- Cross-Space Runtime Discovery must not scan restrictions for other entities.
CREATE INDEX idx_model_access_ceilings_entity
  ON model_access_ceilings(entity_type, entity_id, space_id, model_key, max_access);
UPDATE schema_metadata SET value='80' WHERE key='schema_version';
