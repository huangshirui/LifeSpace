-- Check-in facts belong to Core and are independent of Temporal's anchorDate history.
CREATE TABLE check_in_occurrences (
  id TEXT PRIMARY KEY CHECK(id GLOB 'cki_*'),
  record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  checked_on TEXT NOT NULL CHECK(length(checked_on)=10),
  recorded_by_type TEXT NOT NULL CHECK(recorded_by_type IN ('user','service','device','agent')),
  recorded_by_id TEXT NOT NULL,
  recorded_by_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(record_id,checked_on)
);
CREATE INDEX idx_check_in_occurrences_record_date
  ON check_in_occurrences(record_id,checked_on DESC,id DESC);
UPDATE schema_metadata SET value='69' WHERE key='schema_version';
