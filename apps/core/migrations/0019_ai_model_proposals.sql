-- Extend the existing Model Definition draft table into the audited proposal
-- store used by AI Admin. AI proposals are never publication authority by
-- themselves; publish still goes through the normal Model Registry validator.

ALTER TABLE model_definition_drafts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK(source IN ('manual','ai'));

ALTER TABLE model_definition_drafts
  ADD COLUMN proposal_status TEXT NOT NULL DEFAULT 'draft'
  CHECK(proposal_status IN ('draft','proposed','published','discarded'));

ALTER TABLE model_definition_drafts
  ADD COLUMN instruction_text TEXT;

ALTER TABLE model_definition_drafts
  ADD COLUMN schema_hash TEXT
  CHECK(schema_hash IS NULL OR length(schema_hash)=64);

ALTER TABLE model_definition_drafts
  ADD COLUMN diff_json TEXT
  CHECK(diff_json IS NULL OR json_valid(diff_json));

ALTER TABLE model_definition_drafts
  ADD COLUMN recommended_compatibility TEXT
  CHECK(recommended_compatibility IS NULL OR recommended_compatibility IN ('initial','compatible','breaking'));

ALTER TABLE model_definition_drafts
  ADD COLUMN ai_summary TEXT;

ALTER TABLE model_definition_drafts
  ADD COLUMN ai_warnings_json TEXT
  CHECK(ai_warnings_json IS NULL OR json_valid(ai_warnings_json));

ALTER TABLE model_definition_drafts
  ADD COLUMN published_model_id TEXT;

ALTER TABLE model_definition_drafts
  ADD COLUMN published_at TEXT;

ALTER TABLE model_definition_drafts
  ADD COLUMN discarded_at TEXT;

CREATE INDEX idx_model_definition_ai_proposals_status
  ON model_definition_drafts(source,proposal_status,updated_at DESC);

UPDATE schema_metadata SET value='19' WHERE key='schema_version';
