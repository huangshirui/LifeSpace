-- Align Task completion attribution with the platform Actor vocabulary.
--
-- The canonical Task Model Definition assigns completedByType from actor.type.
-- Delegated Agent execution therefore requires both the logical enum and the
-- typed-storage CHECK constraint to accept 'agent'. Existing values remain valid.
--
-- This is a breaking Model Contract evolution because an older generated
-- response enum cannot describe the newly possible 'agent' value, even though
-- no existing Task row or request shape is invalidated.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_task_agent_actor_20260902',
  'task',
  'tasks',
  COALESCE(MAX(version),0)+1,
  'published',
  1,
  '{"access":["read","write"],"actions":{"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"type":"string"},"completedByType":{"nullable":true,"readOnly":true,"type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"description":"Current lifecycle state of the task.","required":true,"type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  '2e23f3b41d4eab3e6c896579e1271352f078fb98cc390bb8f9dadb7719a26d1f',
  'breaking',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace bootstrap'
FROM model_definitions
WHERE model_key='task';

UPDATE resource_records
SET model_version=(
  SELECT version FROM model_definitions
  WHERE model_key='task' AND state='published'
)
WHERE model_key='task';

CREATE TABLE mdl_task_agent_actor (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "completedAt" TEXT,
  "completedById" TEXT,
  "completedByType" TEXT CHECK("completedByType" IS NULL OR "completedByType" IN ('user','service','device','agent')),
  "description" TEXT,
  "dueDate" TEXT,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN ('pending','completed','cancelled')),
  UNIQUE(space_id,record_id)
);

INSERT INTO mdl_task_agent_actor(
  record_id,space_id,"completedAt","completedById","completedByType","description","dueDate","name","status"
)
SELECT
  record_id,space_id,"completedAt","completedById","completedByType","description","dueDate","name","status"
FROM mdl_task;

DROP TABLE mdl_task;
ALTER TABLE mdl_task_agent_actor RENAME TO mdl_task;

CREATE INDEX idx_mdl_task_dueDate ON mdl_task(space_id,"dueDate",record_id);
CREATE INDEX idx_mdl_task_name ON mdl_task(space_id,"name",record_id);
CREATE INDEX idx_mdl_task_status ON mdl_task(space_id,"status",record_id);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='34' WHERE key='schema_version';
