-- Proposal publication uses an explicit claim so the same proposal cannot be
-- published/discarded concurrently. The Model Registry publication remains its
-- own atomic D1 mutation. If the request dies after Registry publication but
-- before proposal audit finalization, the claim lets a later request reconcile
-- the exact model key/version/schema hash instead of publishing twice.

ALTER TABLE model_definition_drafts
  ADD COLUMN publication_token TEXT;

ALTER TABLE model_definition_drafts
  ADD COLUMN publication_started_at TEXT;

CREATE UNIQUE INDEX idx_model_definition_drafts_publication_token
  ON model_definition_drafts(publication_token)
  WHERE publication_token IS NOT NULL;

UPDATE schema_metadata SET value='20' WHERE key='schema_version';
