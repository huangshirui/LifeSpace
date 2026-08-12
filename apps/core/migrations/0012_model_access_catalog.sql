CREATE TABLE application_model_access (
  application_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  max_access TEXT NOT NULL CHECK(max_access IN ('read','write','manage')),
  created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user','service','device')),
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(application_id, model_key)
);

CREATE INDEX idx_application_model_access_model
  ON application_model_access(model_key, max_access, application_id);

UPDATE schema_metadata
SET value='12'
WHERE key='schema_version';
