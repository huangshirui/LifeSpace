-- #200: modelKey is the only ordinary-model Runtime address identity.
-- D1 keeps foreign keys enabled during migrations, so this migration deliberately
-- leaves the referenced Registry table in place. route_segment remains only as a
-- deprecated physical compatibility column; Runtime code never reads it. New rows
-- store model_key there solely to satisfy the historical NOT NULL constraint.

CREATE TABLE migration_0037_preflight_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_count INTEGER NOT NULL CHECK(published_count = 4),
  unexpected_published_count INTEGER NOT NULL CHECK(unexpected_published_count = 0),
  active_ai_proposal_count INTEGER NOT NULL CHECK(active_ai_proposal_count = 0)
);

INSERT INTO migration_0037_preflight_guard(id,published_count,unexpected_published_count,active_ai_proposal_count)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE state='published'),
  (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND NOT (
    (model_key='task' AND route_segment='tasks' AND schema_hash='1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837') OR
    (model_key='wish' AND route_segment='wishes' AND schema_hash='4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3') OR
    (model_key='day_record' AND route_segment='day-records' AND schema_hash='7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa') OR
    (model_key='event' AND route_segment='events' AND schema_hash='66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4')
  )),
  (SELECT COUNT(*) FROM model_definition_drafts WHERE source='ai' AND proposal_status IN ('draft','proposed'));

DROP TABLE migration_0037_preflight_guard;

-- This index encoded the removed active route identity. The table-level historical
-- uniqueness constraint is retained only because removing it would require a rebuild.
DROP INDEX IF EXISTS idx_model_definitions_active_route;

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE state='published' AND model_key IN ('task','wish','day_record','event');

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_task_model_key_address_20260908','task','task',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),'e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions WHERE model_key='task' AND state='superseded'
  AND schema_hash='1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_wish_model_key_address_20260908','wish','wish',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),'7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions WHERE model_key='wish' AND state='superseded'
  AND schema_hash='4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_day_record_model_key_address_20260908','day_record','day_record',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),'9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions WHERE model_key='day_record' AND state='superseded'
  AND schema_hash='7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa'
ORDER BY version DESC LIMIT 1;

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_event_model_key_address_20260908','event','event',version+1,'published',definition_version,
  json_remove(definition_json, '$.route'),'35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f','breaking',
  'service','svc_lifespace_bootstrap','LifeSpace schema 37 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM model_definitions WHERE model_key='event' AND state='superseded'
  AND schema_hash='66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4'
ORDER BY version DESC LIMIT 1;

CREATE TABLE migration_0037_post_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_count INTEGER NOT NULL CHECK(published_count = 4),
  unexpected_published_count INTEGER NOT NULL CHECK(unexpected_published_count = 0)
);

INSERT INTO migration_0037_post_guard(id,published_count,unexpected_published_count)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE state='published'),
  (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND NOT (
    (model_key='task' AND schema_hash='e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e') OR
    (model_key='wish' AND schema_hash='7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df') OR
    (model_key='day_record' AND schema_hash='9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852') OR
    (model_key='event' AND schema_hash='35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f')
  ));

DROP TABLE migration_0037_post_guard;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='37' WHERE key='schema_version';
