ALTER TABLE creation_draft_jobs ADD COLUMN requesting_client_id TEXT;
ALTER TABLE creation_draft_jobs ADD COLUMN model_contract_revision TEXT;
ALTER TABLE creation_draft_jobs ADD COLUMN target_model_key TEXT;

CREATE INDEX idx_creation_draft_jobs_contract
  ON creation_draft_jobs(model_contract_revision,created_at DESC);
CREATE INDEX idx_creation_draft_jobs_target_model
  ON creation_draft_jobs(target_model_key,status);

UPDATE schema_metadata
SET value='15'
WHERE key='schema_version';
