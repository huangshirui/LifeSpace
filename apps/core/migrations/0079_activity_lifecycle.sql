-- Schema 79: Activity explicit lifecycle (Issue #578).
-- Additive, server-defaulted read-only field; no previous client input changes.
-- Existing dates cannot prove lifecycle completion. All historical records
-- receive the explicit migration default active; owners may correct via Actions.
-- The storage default also protects old Worker inserts during rollout.
-- Keep immutable model history, record IDs, relations, icons and audit intact.
-- Requires schema 78 and the reviewed Activity contract.
CREATE TABLE _schema79_activity_preflight (
  schema_version INTEGER NOT NULL CHECK(schema_version=78),
  published_count INTEGER NOT NULL CHECK(published_count=1),
  old_hash_count INTEGER NOT NULL CHECK(old_hash_count=1),
  record_count INTEGER NOT NULL,
  storage_count INTEGER NOT NULL,
  CHECK(record_count=storage_count)
);
INSERT INTO _schema79_activity_preflight
SELECT
  (SELECT CAST(value AS INTEGER) FROM schema_metadata WHERE key='schema_version'),
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='activity' AND state='published'),
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='activity' AND state='published' AND schema_hash='4fc8e1508b90e26f69ce5612d5291250bf87b5032431df4f54dfb15ef896c67c'),
  (SELECT COUNT(*) FROM resource_records WHERE model_key='activity'),
  (SELECT COUNT(*) FROM mdl_activity);

ALTER TABLE "mdl_activity" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active'
  CHECK("status" IS NULL OR "status" IN ('planned','active','completed','cancelled'));
CREATE INDEX "idx_mdl_activity_status" ON "mdl_activity"(space_id,"status",record_id);

UPDATE model_definitions
SET state='superseded', superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='activity' AND state='published' AND schema_hash='4fc8e1508b90e26f69ce5612d5291250bf87b5032431df4f54dfb15ef896c67c';

INSERT INTO model_definitions (
  id,model_key,route_segment,version,state,definition_version,definition_json,
  schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_activity_20261114_lifecycle','activity','activity',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='activity'),0)+1,
  'published',1,'{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"neq","value":"completed"},{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"neq","value":"cancelled"}],"set":{"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"eq","value":"active"}],"set":{"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"neq","value":"planned"},{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"neq","value":"active"}],"set":{"status":"active"}},"reset":{"access":"write","guards":[{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"eq","value":"active"}],"set":{"status":"planned"}},"start":{"access":"write","guards":[{"errorCode":"ACTIVITY_INVALID_TRANSITION","field":"status","op":"eq","value":"planned"}],"set":{"status":"active"}}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A shared undertaking such as a trip, camp or competition, possibly spanning days; groups related records. Not a single Event or desired Goal.","display":{"plural":"Activities","singular":"Activity"},"fields":{"attendeePersonIds":{"description":"People involved; may be empty.","title":"Attendees","type":"person_list"},"description":{"description":"Optional purpose or context.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"endDate":{"description":"Last date, if known.","nullable":true,"title":"End Date","type":"date"},"name":{"description":"Name of the activity.","maxLength":150,"minLength":1,"required":true,"title":"Name","type":"string"},"startDate":{"description":"First date, if known.","nullable":true,"title":"Start Date","type":"date"},"status":{"description":"The current lifecycle state of the activity, independent of dates and controlled by explicit actions.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["planned","active","completed","cancelled"]}},"key":"activity","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["attendeePersonIds","startDate","endDate","status"],"searchable":["name","description"],"sortable":["startDate","endDate","name"]},"referenceLabel":{"field":"name"},"semanticRelations":{"outgoing":["relates_to"]}}','bfe9da30ec2338c70bcb93d777765047bcf02e91977ee83a0f20d1d98b26dbea','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace schema 79 Activity lifecycle',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (
  SELECT 1 FROM model_definitions WHERE model_key='activity' AND state='superseded'
    AND schema_hash='4fc8e1508b90e26f69ce5612d5291250bf87b5032431df4f54dfb15ef896c67c'
);

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='activity' AND state='published')
WHERE model_key='activity';

CREATE TABLE _schema79_activity_postflight (
  published_count INTEGER NOT NULL CHECK(published_count=1),
  new_hash_count INTEGER NOT NULL CHECK(new_hash_count=1),
  prior_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  storage_count INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  CHECK(prior_count=record_count AND record_count=storage_count AND storage_count=active_count)
);
INSERT INTO _schema79_activity_postflight
SELECT
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='activity' AND state='published'),
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='activity' AND state='published' AND schema_hash='bfe9da30ec2338c70bcb93d777765047bcf02e91977ee83a0f20d1d98b26dbea'),
  (SELECT record_count FROM _schema79_activity_preflight),
  (SELECT COUNT(*) FROM resource_records WHERE model_key='activity'),
  (SELECT COUNT(*) FROM mdl_activity),
  (SELECT COUNT(*) FROM mdl_activity WHERE status='active');
DROP TABLE _schema79_activity_postflight;
DROP TABLE _schema79_activity_preflight;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;
DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='79' WHERE key='schema_version';
