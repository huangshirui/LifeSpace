-- A claimed AI proposal is finalized by the exact Model Registry INSERT that
-- publishes its next immutable version. SQLite triggers execute inside the same
-- D1 batch/transaction as model_definitions INSERT, so model publication and
-- proposal audit cannot commit independently.
--
-- Matching is deliberately content/version based. If another authorized Model
-- Admin path wins the global Registry CAS with the exact proposal content while
-- the proposal is actively claimed, that exact publication satisfies the
-- proposal rather than causing a duplicate model version.

CREATE TRIGGER finalize_claimed_ai_model_proposal_after_publication
AFTER INSERT ON model_definitions
WHEN NEW.state='published'
BEGIN
  UPDATE model_definition_drafts
  SET proposal_status='published',
      published_model_id=NEW.id,
      published_at=NEW.published_at,
      updated_at=NEW.published_at,
      publication_token=NULL,
      publication_started_at=NULL
  WHERE source='ai'
    AND proposal_status='proposed'
    AND publication_token IS NOT NULL
    AND model_key=NEW.model_key
    AND schema_hash=NEW.schema_hash
    AND COALESCE(base_published_version,0)+1=NEW.version;
END;

UPDATE schema_metadata SET value='21' WHERE key='schema_version';
