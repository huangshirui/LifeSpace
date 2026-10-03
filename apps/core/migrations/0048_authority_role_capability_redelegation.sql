-- #302: generalize Authority roles for Agent Principal and bounded re-delegation.
--
-- This is a structural migration. Existing User/Service/Device values keep their
-- exact meaning. Existing single-hop Delegations become root rows with
-- parent_delegation_id=NULL and remaining_redelegation_depth=0.
--
-- IMPORTANT D1 migration invariant:
-- resource_records is a heavily referenced parent of generated mdl_* tables,
-- relations, Change evidence and Capability storage. D1 remote migrations enforce
-- those foreign keys while applying a migration, so this migration must never
-- rebuild/drop resource_records. Its closed legacy audit type columns are retained
-- as compatibility carriers and paired with additive exact Entity Type columns.

-- Data Grant may now target Agent and future verified principal-capable entity
-- types without rebuilding this table for every vocabulary extension.
CREATE TABLE _migration_0048_data_grants (
  id TEXT PRIMARY KEY,
  source_space_id TEXT NOT NULL REFERENCES spaces(id),
  grantee_type TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  permission TEXT NOT NULL CHECK (permission IN ('free_busy','read','write','manage')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

INSERT INTO _migration_0048_data_grants(
  id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,
  permission,created_by_user_id,created_at,expires_at,revoked_at
)
SELECT
  id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,
  permission,created_by_user_id,created_at,expires_at,revoked_at
FROM data_grants;

DROP TABLE data_grants;
ALTER TABLE _migration_0048_data_grants RENAME TO data_grants;

CREATE INDEX idx_data_grants_grantee
  ON data_grants(grantee_type, grantee_id, revoked_at, expires_at);
CREATE INDEX idx_data_grants_source
  ON data_grants(source_space_id, resource_type, resource_id, revoked_at);

-- Generic Resource audit attribution must preserve the exact verified Entity Type
-- without rebuilding resource_records. The historical created_by_type /
-- updated_by_type columns keep their pre-48 CHECK constraints solely as D1-safe
-- compatibility carriers. New Runtime code writes the exact type here and uses a
-- legacy-safe carrier value only for those historical columns.
ALTER TABLE resource_records ADD COLUMN created_by_entity_type TEXT;
ALTER TABLE resource_records ADD COLUMN updated_by_entity_type TEXT;

UPDATE resource_records
SET created_by_entity_type=created_by_type,
    updated_by_entity_type=updated_by_type
WHERE created_by_entity_type IS NULL OR updated_by_entity_type IS NULL;

-- Eventing must publish the exact Entity Type rather than the compatibility
-- carrier retained in the legacy audit columns.
DROP TRIGGER IF EXISTS trg_domain_event_resource_created;
DROP TRIGGER IF EXISTS trg_domain_event_resource_updated;
DROP TRIGGER IF EXISTS trg_domain_event_resource_deleted;

CREATE TRIGGER trg_domain_event_resource_created
AFTER INSERT ON resource_records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.created',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    COALESCE(NEW.created_by_entity_type,NEW.created_by_type),
    NEW.created_by_id,
    NEW.created_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_updated
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.updated',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    COALESCE(NEW.updated_by_entity_type,NEW.updated_by_type),
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

CREATE TRIGGER trg_domain_event_resource_deleted
AFTER UPDATE ON resource_records
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND NEW.version > OLD.version
BEGIN
  INSERT INTO domain_event_outbox(
    id,event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id,occurred_at
  ) VALUES(
    'evt_' || lower(hex(randomblob(16))),
    'record.deleted',
    NEW.space_id,
    NEW.model_key,
    NEW.id,
    NEW.version,
    NEW.mutation_token,
    COALESCE(NEW.updated_by_entity_type,NEW.updated_by_type),
    NEW.updated_by_id,
    NEW.updated_at
  );
END;

-- Temporal Capability audit uses the same open Principal vocabulary as runtime
-- Change evidence. This table is a leaf over resource_records, so it can be
-- rebuilt safely without dropping the referenced parent.
CREATE TABLE _migration_0048_temporal_occurrences (
  id TEXT PRIMARY KEY CHECK(id GLOB 'tmo_*'),
  record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10),
  note TEXT CHECK(note IS NULL OR length(note)<=1000),
  source TEXT NOT NULL CHECK(source IN ('initial','manual')),
  recorded_by_type TEXT NOT NULL,
  recorded_by_id TEXT NOT NULL,
  recorded_by_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(record_id,occurred_on)
);

INSERT INTO _migration_0048_temporal_occurrences(
  id,record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,
  recorded_by_name_snapshot,created_at
)
SELECT
  id,record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,
  recorded_by_name_snapshot,created_at
FROM temporal_occurrences;

DROP TABLE temporal_occurrences;
ALTER TABLE _migration_0048_temporal_occurrences RENAME TO temporal_occurrences;

CREATE INDEX idx_temporal_occurrences_record_date
  ON temporal_occurrences(record_id,occurred_on DESC,id DESC);

CREATE TRIGGER trg_temporal_occurrences_insert_actor_name
AFTER INSERT ON temporal_occurrences
WHEN NEW.recorded_by_type = 'user'
  AND NEW.recorded_by_name_snapshot = NEW.recorded_by_id
BEGIN
  UPDATE temporal_occurrences
  SET recorded_by_name_snapshot = COALESCE(
    (
      SELECT p.display_name
      FROM resource_records r
      JOIN space_people p
        ON p.space_id = r.space_id
        AND p.linked_user_id = NEW.recorded_by_id
      WHERE r.id = NEW.record_id
      ORDER BY (p.deleted_at IS NULL) DESC, p.updated_at DESC, p.created_at DESC
      LIMIT 1
    ),
    NEW.recorded_by_name_snapshot
  )
  WHERE id = NEW.id;
END;

-- Extend the generic Delegation row rather than adding another Agent-specific
-- persistence model. Existing rows inherit root/no-propagation defaults.
ALTER TABLE delegations
  ADD COLUMN parent_delegation_id TEXT REFERENCES delegations(id);

ALTER TABLE delegations
  ADD COLUMN remaining_redelegation_depth INTEGER NOT NULL DEFAULT 0
    CHECK(remaining_redelegation_depth BETWEEN 0 AND 3);

CREATE INDEX idx_delegations_parent
  ON delegations(parent_delegation_id,id)
  WHERE parent_delegation_id IS NOT NULL;

-- Rebuild Change evidence tables only to remove the old Principal/Actor enum
-- CHECKs. Historical attribution values remain byte-for-byte equivalent.
DROP TRIGGER IF EXISTS trg_resource_change_consume_single_use_delegation;
DROP TRIGGER IF EXISTS trg_resource_change_set_require_complete;

CREATE TABLE _migration_0048_resource_changes (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES resource_records(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  model_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','action','delete')),
  version_before INTEGER,
  version_after INTEGER NOT NULL CHECK(version_after >= 1),
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  delegation_id TEXT REFERENCES delegations(id),
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL,
  action_key TEXT,
  field_changes_json TEXT,
  change_set_id TEXT CHECK(change_set_id IS NULL OR change_set_id GLOB 'cgs_*')
);

INSERT INTO _migration_0048_resource_changes(
  id,record_id,space_id,model_key,operation,version_before,version_after,
  principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,
  changed_fields_json,occurred_at,action_key,field_changes_json,change_set_id
)
SELECT
  id,record_id,space_id,model_key,operation,version_before,version_after,
  principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,
  changed_fields_json,occurred_at,action_key,field_changes_json,change_set_id
FROM resource_changes;

DROP TABLE resource_changes;
ALTER TABLE _migration_0048_resource_changes RENAME TO resource_changes;

CREATE INDEX idx_resource_changes_record
  ON resource_changes(record_id, version_after DESC, occurred_at DESC);
CREATE INDEX idx_resource_changes_space_time
  ON resource_changes(space_id, occurred_at DESC, id DESC);
CREATE INDEX idx_resource_changes_actor
  ON resource_changes(actor_type, actor_id, occurred_at DESC);
CREATE INDEX idx_resource_changes_delegation
  ON resource_changes(delegation_id, occurred_at DESC)
  WHERE delegation_id IS NOT NULL;
CREATE INDEX idx_resource_changes_change_set
  ON resource_changes(change_set_id,occurred_at,id)
  WHERE change_set_id IS NOT NULL;

CREATE TABLE _migration_0048_resource_change_sets (
  id TEXT PRIMARY KEY CHECK(id GLOB 'cgs_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 20),
  occurred_at TEXT NOT NULL,
  committed_at TEXT
);

INSERT INTO _migration_0048_resource_change_sets(
  id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,
  operation_count,occurred_at,committed_at
)
SELECT
  id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,
  operation_count,occurred_at,committed_at
FROM resource_change_sets;

DROP TABLE resource_change_sets;
ALTER TABLE _migration_0048_resource_change_sets RENAME TO resource_change_sets;

CREATE TRIGGER trg_resource_change_set_require_complete
BEFORE UPDATE OF committed_at ON resource_change_sets
WHEN NEW.committed_at IS NOT NULL AND OLD.committed_at IS NULL
BEGIN
  SELECT (CASE
    WHEN (
      SELECT COUNT(*)
      FROM resource_changes c
      WHERE c.change_set_id=NEW.id
    ) <> NEW.operation_count
    THEN RAISE(ABORT, 'CHANGE_SET_INCOMPLETE')
  END);
END;

-- Durable evidence of the exact Delegation chain used by a committed Change.
-- chain_position=0 is the root and the highest position is the request leaf.
CREATE TABLE resource_change_delegations (
  change_id TEXT NOT NULL REFERENCES resource_changes(id) ON DELETE CASCADE,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  chain_position INTEGER NOT NULL CHECK(chain_position BETWEEN 0 AND 3),
  PRIMARY KEY(change_id,chain_position),
  UNIQUE(change_id,delegation_id)
);

CREATE INDEX idx_resource_change_delegations_delegation
  ON resource_change_delegations(delegation_id,change_id);

-- Preserve historical single-hop Change attribution as a one-row chain.
INSERT INTO resource_change_delegations(change_id,delegation_id,chain_position)
SELECT id,delegation_id,0
FROM resource_changes
WHERE delegation_id IS NOT NULL;

-- Every inserted chain edge is also the atomic single-use exercise point. The
-- business Change row already exists in the same D1 batch/transaction, so any
-- unavailable ancestor aborts and rolls back the whole mutation/ChangeSet.
CREATE TRIGGER trg_resource_change_delegation_consume_single_use
BEFORE INSERT ON resource_change_delegations
WHEN EXISTS(
  SELECT 1 FROM delegations
  WHERE id=NEW.delegation_id AND max_uses=1
)
BEGIN
  UPDATE delegations
  SET consumed_at=(
        SELECT occurred_at FROM resource_changes WHERE id=NEW.change_id
      ),
      consumed_by_change_id=NEW.change_id
  WHERE id=NEW.delegation_id
    AND max_uses=1
    AND consumed_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'));

  SELECT (CASE
    WHEN NOT EXISTS(
      SELECT 1
      FROM delegations
      WHERE id=NEW.delegation_id
        AND max_uses=1
        AND consumed_by_change_id=NEW.change_id
    )
    THEN RAISE(ABORT, 'DELEGATION_SINGLE_USE_UNAVAILABLE')
  END);
END;

UPDATE schema_metadata SET value='48' WHERE key='schema_version';