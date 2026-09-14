CREATE TABLE resource_provenance (
  record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL CHECK(record_version >= 1),
  source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 100),
  source_ref_json TEXT,
  derived_from_json TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(record_id, record_version),
  FOREIGN KEY(record_id) REFERENCES resource_records(id) ON DELETE CASCADE
);
