-- Make Action-owned lifecycle fields authoritative at the Model Definition boundary.
--
-- Task.status and Wish.status become client read-only while remaining writable by
-- trusted Actions. Task gains an explicit cancel Action so every published Task
-- lifecycle state remains reachable through semantic mutation after direct PATCH
-- is denied.
--
-- No typed-storage shape changes are required. This is nevertheless a breaking
-- Model Contract evolution because status is removed from ordinary create/update
-- request schemas. Existing records remain valid and are only advanced to the new
-- published Model Definition version.
--
-- Downstream compatibility reviewed for the current HomeMew client: ordinary Task
-- and Wish edit payloads do not write status; Task complete/reopen and Wish
-- fulfill/reopen already use semantic Action endpoints. No HomeMew code change is
-- required for those paths. Any other consumer that writes Task/Wish status
-- directly must migrate to the declared Actions; Task cancellation now uses
-- actions/cancel.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_task_mutation_authority_20260902',
  'task',
  'tasks',
  COALESCE(MAX(version),0)+1,
  'published',
  1,
  '{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_CANCELLED","field":"status","message":"Task is already cancelled","op":"neq","value":"cancelled"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"type":"string"},"completedByType":{"nullable":true,"readOnly":true,"type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"description":"Current lifecycle state of the task.","readOnly":true,"required":true,"type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  'aaa6317b3810a20e6c4622736ec8e39e96edcd5079c6189fb5892ac54397b145',
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

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_wish_mutation_authority_20260902',
  'wish',
  'wishes',
  COALESCE(MAX(version),0)+1,
  'published',
  1,
  '{"access":["read","write"],"actions":{"fulfill":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be fulfilled","op":"eq","value":"open"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":{"$ref":"now"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_NOT_FULFILLED","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"description":"An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。","display":{"plural":"Wishes","singular":"Wish"},"fields":{"description":{"description":"Optional detail about the aspiration and why it is desired.","maxLength":5000,"nullable":true,"type":"text"},"desiredDate":{"description":"A hoped-for date, not a committed task deadline or scheduled event time.","nullable":true,"type":"date"},"fulfilledAt":{"description":"When the wish was marked fulfilled.","nullable":true,"readOnly":true,"type":"datetime"},"ownerPersonId":{"description":"The person whose aspiration this is.","immutable":true,"required":true,"type":"person"},"status":{"description":"Whether the wish is still waiting to happen or has been fulfilled.","readOnly":true,"required":true,"type":"enum","values":["open","fulfilled"]},"title":{"description":"A concise statement of the aspiration or desired outcome.","maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"read":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"update":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}},"query":{"filterable":["status","ownerPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"route":"wishes"}',
  'ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6',
  'breaking',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace bootstrap'
FROM model_definitions
WHERE model_key='wish';

UPDATE resource_records
SET model_version=(
  SELECT version FROM model_definitions
  WHERE model_key='wish' AND state='published'
)
WHERE model_key='wish';

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='35' WHERE key='schema_version';
