-- #200: modelKey is the only ordinary-model Runtime address identity.
-- Historical immutable contract revisions remain as deployment evidence, while
-- current Registry rows and future publications no longer persist route.
PRAGMA foreign_keys = OFF;

CREATE TABLE model_definitions_model_key_addressed (
  id TEXT PRIMARY KEY CHECK(id GLOB 'mdl_*'),
  model_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  state TEXT NOT NULL CHECK(state IN ('published','superseded','retired')),
  definition_version INTEGER NOT NULL CHECK(definition_version = 1),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  schema_hash TEXT NOT NULL CHECK(length(schema_hash) = 64),
  compatibility TEXT NOT NULL CHECK(compatibility IN ('initial','compatible','breaking')),
  published_by_type TEXT NOT NULL CHECK(published_by_type IN ('user','service','device')),
  published_by_id TEXT NOT NULL,
  published_by_name_snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  superseded_at TEXT,
  retired_at TEXT,
  UNIQUE(model_key, version)
);

INSERT INTO model_definitions_model_key_addressed(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at,superseded_at,retired_at
)
SELECT
  id,model_key,version,state,definition_version,json_remove(definition_json, '$.route'),
  CASE
    WHEN state='published' AND model_key='task' THEN 'e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e'
    WHEN state='published' AND model_key='wish' THEN '7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df'
    WHEN state='published' AND model_key='day_record' THEN '9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852'
    WHEN state='published' AND model_key='event' THEN '35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f'
    ELSE schema_hash
  END,
  compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at,superseded_at,retired_at
FROM model_definitions;

DROP TABLE model_definitions;
ALTER TABLE model_definitions_model_key_addressed RENAME TO model_definitions;

CREATE UNIQUE INDEX idx_model_definitions_active_key
  ON model_definitions(model_key)
  WHERE state='published';

CREATE INDEX idx_model_definitions_history
  ON model_definitions(model_key, version DESC);

-- Rebuilding model_definitions drops its publication-audit trigger. Restore it
-- so an AI proposal claim and the matching immutable Registry insert remain
-- atomic after this migration.
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

-- The generated path/manifest bytes changed even when ordinary domain fields did
-- not. Reconcile the active immutable mct_* lazily from the current Registry.
DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='37' WHERE key='schema_version';

PRAGMA foreign_keys = ON;
