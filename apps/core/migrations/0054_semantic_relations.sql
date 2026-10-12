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
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_semantic_relation_changes_relation
  ON semantic_relation_changes(relation_id,occurred_at DESC,id DESC);
CREATE INDEX idx_semantic_relation_changes_space_time
  ON semantic_relation_changes(space_id,occurred_at DESC,id DESC);
CREATE INDEX idx_semantic_relation_changes_actor
  ON semantic_relation_changes(actor_type,actor_id,occurred_at DESC,id DESC);

-- Keep the exact Delegation chain used by a Relation mutation. As with ordinary
-- resource Change evidence, inserting a single-use ancestor is the atomic consume
-- point and aborts the whole D1 batch when the grant is no longer current.
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

UPDATE schema_metadata SET value='54' WHERE key='schema_version';
