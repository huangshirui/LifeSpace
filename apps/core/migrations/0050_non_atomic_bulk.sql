-- #309: first-class non-atomic Bulk CRUD correlation.
--
-- A Bulk request is a transport/performance grouping with independent item outcomes.
-- It is deliberately not an atomic ChangeSet. Successful items remain ordinary
-- governed Changes; failed items create no Change or Domain Event.

CREATE TABLE resource_bulk_requests (
  id TEXT PRIMARY KEY CHECK(id GLOB 'blk_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 20),
  succeeded_count INTEGER CHECK(succeeded_count IS NULL OR succeeded_count BETWEEN 0 AND operation_count),
  failed_count INTEGER CHECK(failed_count IS NULL OR failed_count BETWEEN 0 AND operation_count),
  occurred_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(
    completed_at IS NULL
    OR (succeeded_count IS NOT NULL AND failed_count IS NOT NULL AND succeeded_count + failed_count = operation_count)
  )
);

CREATE INDEX idx_resource_bulk_requests_space_time
  ON resource_bulk_requests(space_id,occurred_at DESC,id DESC);

ALTER TABLE resource_changes
  ADD COLUMN bulk_id TEXT CHECK(bulk_id IS NULL OR bulk_id GLOB 'blk_*');
CREATE INDEX idx_resource_changes_bulk
  ON resource_changes(bulk_id,occurred_at,id) WHERE bulk_id IS NOT NULL;

ALTER TABLE domain_event_outbox
  ADD COLUMN bulk_id TEXT CHECK(bulk_id IS NULL OR bulk_id GLOB 'blk_*');
CREATE INDEX idx_domain_event_outbox_bulk
  ON domain_event_outbox(bulk_id,occurred_at,id) WHERE bulk_id IS NOT NULL;

CREATE TRIGGER trg_resource_change_one_grouping
BEFORE INSERT ON resource_changes
WHEN NEW.change_set_id IS NOT NULL AND NEW.bulk_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CHANGE_GROUPING_CONFLICT');
END;

CREATE TRIGGER trg_domain_event_one_grouping
BEFORE UPDATE OF change_set_id,bulk_id ON domain_event_outbox
WHEN NEW.change_set_id IS NOT NULL AND NEW.bulk_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'EVENT_GROUPING_CONFLICT');
END;

UPDATE schema_metadata SET value='50' WHERE key='schema_version';
