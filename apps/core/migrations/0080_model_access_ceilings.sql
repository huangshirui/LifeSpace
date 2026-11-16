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
-- Recurrence has an additional transaction-time guard. Keep its existing
-- membership/Grant/catalog check and compose this current-state ceiling check.
-- Runs only when the existing generation guard is inserted, not on ordinary CRUD.
CREATE TRIGGER recurrence_generation_ceiling_guard
BEFORE INSERT ON recurrence_generation_guards
WHEN NEW.principal_type='user'
 AND NOT EXISTS (
   SELECT 1 FROM space_memberships
   WHERE space_id=NEW.space_id AND user_id=NEW.principal_id
     AND deleted_at IS NULL AND role='owner'
 )
 AND EXISTS (
   SELECT 1 FROM model_access_ceilings
   WHERE space_id=NEW.space_id AND entity_type='user'
     AND entity_id=NEW.principal_id AND model_key IN (NEW.model_key,'task')
     AND max_access IN ('none','read')
 )
BEGIN SELECT RAISE(ABORT,'RECURRENCE_AUTHORITY_UNAVAILABLE'); END;

-- Common governance evidence for both Space managers and Platform Admin.
-- Intentionally separate from record Change History; no model data or credentials.
CREATE TABLE model_access_ceiling_audit (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  entity_type TEXT NOT NULL CHECK (entity_type='user'),
  entity_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  previous_access TEXT CHECK (previous_access IN ('none','read','write','manage')),
  next_access TEXT CHECK (next_access IN ('none','read','write','manage')),
  actor_user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  executor_service_id TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_model_access_ceiling_audit_space
  ON model_access_ceiling_audit(space_id,created_at,id);
UPDATE schema_metadata SET value='80' WHERE key='schema_version';
