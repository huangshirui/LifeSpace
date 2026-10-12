PRAGMA foreign_keys = ON;

-- Predicate-free traversal must preserve cursor ordering without sorting the
-- entire adjacency list. The predicate-specific indexes from 0054 remain.
CREATE INDEX idx_semantic_relations_source_time
  ON semantic_relations(space_id,source_model_key,source_record_id,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_target_time
  ON semantic_relations(space_id,target_model_key,target_record_id,created_at DESC,id DESC);
CREATE INDEX idx_semantic_relations_space_time
  ON semantic_relations(space_id,created_at DESC,id DESC);

-- FKs prove physical existence, not logical liveness. Check at the exact commit
-- point so a previously validated endpoint cannot be soft-deleted before INSERT.
CREATE TRIGGER trg_semantic_relation_live_endpoints
BEFORE INSERT ON semantic_relations
WHEN NOT EXISTS (
  SELECT 1 FROM resource_records
  WHERE id=NEW.source_record_id AND space_id=NEW.space_id
    AND model_key=NEW.source_model_key AND deleted_at IS NULL
) OR NOT EXISTS (
  SELECT 1 FROM resource_records
  WHERE id=NEW.target_record_id AND space_id=NEW.space_id
    AND model_key=NEW.target_model_key AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'SEMANTIC_RELATION_ENDPOINT_UNAVAILABLE');
END;

ALTER TABLE semantic_relation_changes ADD COLUMN bulk_id TEXT REFERENCES resource_bulk_requests(id);

-- Independent relation actions count once toward the unified request, including
-- idempotent creates that legitimately produce no new Change. Attached edges are
-- part of their owning record action and do not add another action receipt.
CREATE TABLE semantic_relation_batch_receipts (
  change_set_id TEXT REFERENCES resource_change_sets(id),
  bulk_id TEXT REFERENCES resource_bulk_requests(id),
  operation_index INTEGER NOT NULL CHECK(operation_index BETWEEN 0 AND 19),
  relation_id TEXT NOT NULL,
  CHECK((change_set_id IS NULL) <> (bulk_id IS NULL))
);
CREATE UNIQUE INDEX idx_semantic_receipts_change_set
  ON semantic_relation_batch_receipts(change_set_id,operation_index) WHERE change_set_id IS NOT NULL;
CREATE UNIQUE INDEX idx_semantic_receipts_bulk
  ON semantic_relation_batch_receipts(bulk_id,operation_index) WHERE bulk_id IS NOT NULL;

DROP TRIGGER trg_resource_change_set_require_complete;
CREATE TRIGGER trg_resource_change_set_require_complete
BEFORE UPDATE OF committed_at ON resource_change_sets
WHEN NEW.committed_at IS NOT NULL AND OLD.committed_at IS NULL
BEGIN
  SELECT (CASE WHEN
    (SELECT COUNT(*) FROM resource_changes WHERE change_set_id=NEW.id)
    + (SELECT COUNT(*) FROM semantic_relation_batch_receipts WHERE change_set_id=NEW.id)
    <> NEW.operation_count
  THEN RAISE(ABORT, 'CHANGE_SET_INCOMPLETE') END);
END;

UPDATE schema_metadata SET value='56' WHERE key='schema_version';
