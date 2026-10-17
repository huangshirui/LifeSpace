-- First-class LifeSpace-owned File metadata and bounded upload sessions.
CREATE TABLE files (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,1,4)='fil_' AND substr(id,5) NOT GLOB '*[^0-9a-f]*'),
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status='ready'),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_files_space_created ON files(space_id, created_at DESC);

CREATE TABLE resource_file_links (
  source_record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  source_space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  PRIMARY KEY(source_record_id, field_key, ordinal),
  UNIQUE(source_record_id, field_key, file_id)
);
CREATE INDEX idx_resource_file_links_file ON resource_file_links(file_id);
CREATE INDEX idx_resource_file_links_source ON resource_file_links(source_space_id, source_model_key, source_record_id);

CREATE TRIGGER trg_resource_file_links_insert_guard
BEFORE INSERT ON resource_file_links
BEGIN
  SELECT (CASE WHEN NOT EXISTS(
    SELECT 1 FROM resource_records r
    JOIN files f ON f.id=NEW.file_id
    WHERE r.id=NEW.source_record_id
      AND r.space_id=NEW.source_space_id
      AND r.model_key=NEW.source_model_key
      AND r.deleted_at IS NULL
      AND f.space_id=NEW.source_space_id
      AND f.status='ready'
  ) THEN RAISE(ABORT, 'FILE_REFERENCE_INVALID') END);
END;

CREATE TABLE file_upload_sessions (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,1,4)='upl_' AND substr(id,5) NOT GLOB '*[^0-9a-f]*'),
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  record_id TEXT,
  destination TEXT NOT NULL CHECK(destination IN ('native','external')),
  file_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  expected_size INTEGER NOT NULL CHECK(expected_size > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed','unknown','expired')),
  error_code TEXT,
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_file_upload_sessions_cleanup ON file_upload_sessions(status, expires_at, cleaned_at);
CREATE INDEX idx_file_upload_sessions_space ON file_upload_sessions(space_id, created_at DESC);

UPDATE schema_metadata SET value='67' WHERE key='schema_version';
