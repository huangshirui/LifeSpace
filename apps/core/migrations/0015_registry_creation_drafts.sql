DROP TABLE creation_draft_jobs;

CREATE TABLE creation_draft_jobs (
  id TEXT PRIMARY KEY CHECK(id GLOB 'drf_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  requested_by_user_id TEXT NOT NULL,
  requesting_client_id TEXT NOT NULL,
  model_contract_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','choose_model','ready','failed')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1),
  input_text TEXT CHECK(input_text IS NULL OR length(trim(input_text)) BETWEEN 1 AND 5000),
  viewing_timezone TEXT NOT NULL,
  target_model_key TEXT,
  result_json TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  CHECK(
    (status IN ('queued','processing') AND result_json IS NULL AND error_code IS NULL)
    OR (status IN ('choose_model','ready') AND result_json IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND result_json IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX idx_creation_draft_jobs_owner ON creation_draft_jobs(space_id,requested_by_user_id,created_at DESC);
CREATE INDEX idx_creation_draft_jobs_status ON creation_draft_jobs(status,updated_at);
CREATE INDEX idx_creation_draft_jobs_expiry ON creation_draft_jobs(expires_at);
CREATE INDEX idx_creation_draft_jobs_contract ON creation_draft_jobs(model_contract_revision,created_at DESC);
CREATE INDEX idx_creation_draft_jobs_target_model ON creation_draft_jobs(target_model_key,status);

UPDATE schema_metadata SET value='15' WHERE key='schema_version';
