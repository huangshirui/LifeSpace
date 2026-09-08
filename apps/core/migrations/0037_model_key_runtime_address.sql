-- #200: modelKey is the only ordinary-model Runtime address identity.
--
-- This is an intentionally breaking, one-time convergence migration. Published
-- Model Definition versions are immutable evidence, so route-bearing historical
-- rows are preserved byte-for-byte. The four expected current baseline models
-- are superseded and new route-free versions are published instead.
--
-- Fail closed before touching the Registry when the deployed environment is not
-- the expected baseline or when an unfinished AI Model proposal still depends on
-- the pre-0.32 Definition shape. Operators must resolve that state explicitly.
PRAGMA foreign_keys = OFF;

CREATE TABLE migration_0037_preflight_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_count INTEGER NOT NULL CHECK(published_count = 4),
  unexpected_published_count INTEGER NOT NULL CHECK(unexpected_published_count = 0),
  active_ai_proposal_count INTEGER NOT NULL CHECK(active_ai_proposal_count = 0)
);

INSERT INTO migration_0037_preflight_guard(
  id,published_count,unexpected_published_count,active_ai_proposal_count
)
SELECT
  1,
  (SELECT COUNT(*) FROM model_definitions WHERE state='published'),
  (SELECT COUNT(*) FROM model_definitions
    WHERE state='published' AND NOT (
      (model_key='task' AND route_segment='tasks' AND schema_hash='1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837') OR
      (model_key='wish' AND route_segment='wishes' AND schema_hash='4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3') OR
      (model_key='day_record' AND route_segment='day-records' AND schema_hash='7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa') OR
      (model_key='event' AND route_segment='events' AND schema_hash='66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4')
    )),
  (SELECT COUNT(*) FROM model_definition_drafts
    WHERE source='ai' AND proposal_status IN ('draft','proposed'));

DROP TABLE migration_0037_preflight_guard;

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

-- Preserve every historical immutable version exactly. Historical JSON may still
-- contain `route`; current Runtime readers strip that legacy field when reading an
-- old row as evidence, while only the new published rows define current semantics.
INSERT INTO model_definitions_model_key_addressed(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at,superseded_at,retired_at
)
SELECT
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at,superseded_at,retired_at
FROM model_definitions;

DROP TABLE model_definitions;
ALTER TABLE model_definitions_model_key_addressed RENAME TO model_definitions;

CREATE UNIQUE INDEX idx_model_definitions_active_key
  ON model_definitions(model_key)
  WHERE state='published';

CREATE INDEX idx_model_definitions_history
  ON model_definitions(model_key, version DESC);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE state='published'
  AND model_key IN ('task','wish','day_record','event');

INSERT INTO model_definitions(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_task_model_key_address_20260908','task',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),
  'e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions
WHERE model_key='task' AND state='superseded'
  AND schema_hash='1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_wish_model_key_address_20260908','wish',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),
  '7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions
WHERE model_key='wish' AND state='superseded'
  AND schema_hash='4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_day_record_model_key_address_20260908','day_record',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),
  '9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions
WHERE model_key='day_record' AND state='superseded'
  AND schema_hash='7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_event_model_key_address_20260908','event',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),
  '35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions
WHERE model_key='event' AND state='superseded'
  AND schema_hash='66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4'
ORDER BY version DESC LIMIT 1;

-- Verify that the migration produced exactly the intended current Registry set.
CREATE TABLE migration_0037_post_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_count INTEGER NOT NULL CHECK(published_count = 4),
  unexpected_published_count INTEGER NOT NULL CHECK(unexpected_published_count = 0)
);

INSERT INTO migration_0037_post_guard(id,published_count,unexpected_published_count)
SELECT
  1,
  (SELECT COUNT(*) FROM model_definitions WHERE state='published'),
  (SELECT COUNT(*) FROM model_definitions
    WHERE state='published' AND NOT (
      (model_key='task' AND schema_hash='e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e') OR
      (model_key='wish' AND schema_hash='7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df') OR
      (model_key='day_record' AND schema_hash='9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852') OR
      (model_key='event' AND schema_hash='35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f')
    ));

DROP TABLE migration_0037_post_guard;

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

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

-- Generated paths/manifest bytes and current model versions changed. Reconcile
-- the active immutable mct_* lazily from the new current Registry set.
DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='37' WHERE key='schema_version';

PRAGMA foreign_keys = ON;
