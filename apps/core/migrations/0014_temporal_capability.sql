CREATE TABLE temporal_occurrences (
  id TEXT PRIMARY KEY CHECK(id GLOB 'tmo_*'),
  record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10),
  note TEXT CHECK(note IS NULL OR length(note)<=1000),
  source TEXT NOT NULL CHECK(source IN ('initial','manual')),
  recorded_by_type TEXT NOT NULL CHECK(recorded_by_type IN ('user','service','device')),
  recorded_by_id TEXT NOT NULL,
  recorded_by_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(record_id,occurred_on)
);

CREATE INDEX idx_temporal_occurrences_record_date
  ON temporal_occurrences(record_id,occurred_on DESC,id DESC);

UPDATE schema_metadata
SET value='14'
WHERE key='schema_version';
