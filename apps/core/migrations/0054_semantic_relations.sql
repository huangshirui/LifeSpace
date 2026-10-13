PRAGMA foreign_keys = ON;

-- Semantic Relation is an independent business-semantic edge between two ordinary
-- records in one Space. It is deliberately separate from resource_relations,
-- which remains the projection table for fixed Model Definition relation fields.
CREATE TABLE semantic_relations (
  id TEXT PRIMARY KEY CHECK(id GLOB 'rel_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source_model_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  target_model_key TEXT NOT NULL,
  target_record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id)
);

-- The first columns follow the hot traversal shape. Predicate and stable cursor
-- columns are covered so source/target traversal never needs a table scan.
CREATE INDEX idx_semantic_relations_source
  ON semantic_relations(space_id,source_model_key,source_record_id,predicate,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_target
  ON semantic_relations(space_id,target_model_key,target_record_id,predicate,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_predicate
  ON semantic_relations(space_id,predicate,created_at DESC,id DESC);

-- Append-only execution evidence for Relation mutations. Endpoints are copied as
-- immutable snapshots so deleting an edge or endpoint never destroys attribution.
-- source_resource_change_id/change_set_id link relation extensions back to the
-- ordinary governed Change that owns one atomic Batch operation.
CREATE TABLE semantic_relation_changes (
  id TEXT PRIMARY KEY CHECK(id GLOB 'chg_*'),
  relation_id TEXT NOT NULL CHECK(relation_id GLOB 'rel_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source_model_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  target_model_key TEXT NOT NULL,
  target_record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','delete','endpoint_delete')),
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  delegation_id TEXT REFERENCES delegations(id),
  source_resource_change_id TEXT REFERENCES resource_changes(id),
  change_set_id TEXT REFERENCES resource_change_sets(id),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_semantic_relation_changes_relation
  ON semantic_relation_changes(relation_id,occurred_at DESC,id DESC);
CREATE INDEX idx_semantic_relation_changes_space_time
  ON semantic_relation_changes(space_id,occurred_at DESC,id DESC);
CREATE INDEX idx_semantic_relation_changes_actor
  ON semantic_relation_changes(actor_type,actor_id,occurred_at DESC,id DESC);
CREATE INDEX idx_semantic_relation_changes_change_set
  ON semantic_relation_changes(change_set_id,occurred_at,id) WHERE change_set_id IS NOT NULL;

-- Keep the exact Delegation chain used by a standalone Relation mutation. As with
-- ordinary resource Change evidence, inserting a single-use ancestor is the atomic
-- consume point and aborts the whole D1 batch when the grant is no longer current.
CREATE TABLE semantic_relation_change_delegations (
  change_id TEXT NOT NULL REFERENCES semantic_relation_changes(id) ON DELETE CASCADE,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  chain_position INTEGER NOT NULL CHECK(chain_position BETWEEN 0 AND 3),
  PRIMARY KEY(change_id,chain_position),
  UNIQUE(change_id,delegation_id)
);

CREATE INDEX idx_semantic_relation_change_delegations_delegation
  ON semantic_relation_change_delegations(delegation_id,change_id);

CREATE TRIGGER trg_semantic_relation_change_delegation_consume_single_use
BEFORE INSERT ON semantic_relation_change_delegations
WHEN EXISTS(
  SELECT 1 FROM delegations
  WHERE id=NEW.delegation_id AND max_uses=1
)
BEGIN
  UPDATE delegations
  SET consumed_at=(
        SELECT occurred_at FROM semantic_relation_changes WHERE id=NEW.change_id
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

-- Record deletion already commits one resource_changes row inside the same D1
-- transaction. Use that authoritative delete event to remove incoming/outgoing
-- semantic edges atomically without adding work to ordinary Record read/write paths.
-- model_key is present on resource_changes, so these predicates keep the cleanup on
-- the existing source/target composite indexes instead of requiring separate indexes.
-- The edge snapshot is preserved before deletion. We intentionally do not insert
-- semantic_relation_change_delegations here: the parent resource Change already
-- carries and consumes the exact Delegation chain for this mutation.
CREATE TRIGGER trg_semantic_relations_cleanup_on_record_delete
AFTER INSERT ON resource_changes
WHEN NEW.operation='delete'
BEGIN
  INSERT INTO semantic_relation_changes(
    id,relation_id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,operation,principal_type,principal_id,
    actor_type,actor_id,application_id,delegation_id,source_resource_change_id,
    change_set_id,occurred_at
  )
  SELECT
    'chg_' || lower(hex(randomblob(16))),id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,'endpoint_delete',NEW.principal_type,NEW.principal_id,
    NEW.actor_type,NEW.actor_id,NEW.application_id,NEW.delegation_id,NEW.id,
    NEW.change_set_id,NEW.occurred_at
  FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND source_model_key=NEW.model_key
    AND source_record_id=NEW.record_id;

  INSERT INTO semantic_relation_changes(
    id,relation_id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,operation,principal_type,principal_id,
    actor_type,actor_id,application_id,delegation_id,source_resource_change_id,
    change_set_id,occurred_at
  )
  SELECT
    'chg_' || lower(hex(randomblob(16))),id,space_id,source_model_key,source_record_id,predicate,
    target_model_key,target_record_id,'endpoint_delete',NEW.principal_type,NEW.principal_id,
    NEW.actor_type,NEW.actor_id,NEW.application_id,NEW.delegation_id,NEW.id,
    NEW.change_set_id,NEW.occurred_at
  FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND target_model_key=NEW.model_key
    AND target_record_id=NEW.record_id
    AND source_record_id<>NEW.record_id;

  DELETE FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND source_model_key=NEW.model_key
    AND source_record_id=NEW.record_id;

  DELETE FROM semantic_relations
  WHERE space_id=NEW.space_id
    AND target_model_key=NEW.model_key
    AND target_record_id=NEW.record_id;
END;

UPDATE schema_metadata SET value='54' WHERE key='schema_version';
