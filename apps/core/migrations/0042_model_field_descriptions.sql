-- #230: complete semantic field descriptions for built-in models.
--
-- Description-only Model Definition changes are compatible metadata publications.
-- No typed storage shape or existing resource data changes are required.

CREATE TABLE migration_0042_preflight_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  expected_task_count INTEGER NOT NULL CHECK(expected_task_count = 1),
  expected_day_record_count INTEGER NOT NULL CHECK(expected_day_record_count = 1)
);

INSERT INTO migration_0042_preflight_guard(id,expected_task_count,expected_day_record_count)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='task' AND state='published'
    AND schema_hash='e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e'),
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='day_record' AND state='published'
    AND schema_hash='9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852');

DROP TABLE migration_0042_preflight_guard;

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published'
  AND schema_hash='e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_task_field_descriptions_20260922','task','task',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='task'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_CANCELLED","field":"status","message":"Task is already cancelled","op":"neq","value":"cancelled"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","title":"Assignees","type":"person_list"},"completedAt":{"description":"When the task was completed, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed At","type":"datetime"},"completedById":{"description":"Identifier of the Actor that completed the task, set by the authoritative completion Action.","maxLength":100,"nullable":true,"readOnly":true,"title":"Completed By","type":"string"},"completedByType":{"description":"Type of Actor that completed the task, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed By Type","type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"title":"Due Date","type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"status":{"description":"Current lifecycle state of the task.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]}}',
  'fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6',
  'compatible',
  'service','svc_lifespace_bootstrap','LifeSpace schema 42 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='task' AND state='published'
    AND schema_hash='fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='day_record' AND state='published'
  AND schema_hash='9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT
  'mdl_catalog_day_record_field_descriptions_20260922','day_record','day_record',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='day_record'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ARCHIVED","field":"status","message":"Day record is already archived","op":"neq","value":"archived"}],"set":{"status":"archived"}},"restore":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ALREADY_ACTIVE","field":"status","message":"Day record is already active","op":"neq","value":"active"}],"set":{"status":"active"}}},"capabilities":{"temporal":{"anchorDateField":"anchorDate","attentionAfterDaysField":"attentionAfterDays","attentionBeforeDaysField":"attentionBeforeDays","cycleDaysField":"cycleDays","kindField":"kind","occurrences":true,"statusField":"status","subjectPersonField":"subjectPersonId"}},"definitionVersion":1,"description":"A date-anchored tracker for counting elapsed days, counting down to a date, or representing a recurring/cycle interval. Use for since/until counters, milestones anchored to a date, streaks, and cycle tracking. Do not use for ordinary appointments, one-off calendar occurrences, or concrete to-dos. Examples: 从今天开始戒糖；距离生日还有多少天；每28天一个周期。","display":{"plural":"Day Records","singular":"Day Record"},"fields":{"anchorDate":{"description":"The calendar date that anchors the elapsed, countdown, or cycle calculation.","required":true,"title":"Anchor Date","type":"date"},"attentionAfterDays":{"description":"Number of days after the anchor date when the record should enter an attention window.","minimum":1,"nullable":true,"title":"Attention After Days","type":"integer"},"attentionBeforeDays":{"description":"Number of days before the anchor date when the record should enter an attention window.","minimum":0,"nullable":true,"title":"Attention Before Days","type":"integer"},"cycleDays":{"description":"Length in days for a recurring cycle.","minimum":1,"nullable":true,"title":"Cycle Days","type":"integer"},"description":{"description":"Optional context about the tracked date or cycle.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"icon":{"description":"Optional presentation icon associated with the tracked day record.","maxLength":50,"nullable":true,"title":"Icon","type":"string"},"kind":{"description":"Tracker mode: elapsed since anchorDate, countdown until anchorDate, or recurring cycle.","immutable":true,"required":true,"title":"Kind","type":"enum","values":["elapsed","countdown","cycle"]},"name":{"description":"The milestone, streak, countdown, or cycle being tracked.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"status":{"description":"Current lifecycle state of the day record.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["active","archived"]},"subjectPersonId":{"description":"Optional person the tracked date or cycle belongs to.","nullable":true,"title":"Subject","type":"person"}},"key":"day_record","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["kind","status","subjectPersonId","anchorDate"],"searchable":["name","description"],"sortable":["anchorDate","name"]}}',
  '9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1',
  'compatible',
  'service','svc_lifespace_bootstrap','LifeSpace schema 42 migration',strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='day_record' AND state='published'
    AND schema_hash='9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1'
);

CREATE TABLE migration_0042_post_guard (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  expected_task_count INTEGER NOT NULL CHECK(expected_task_count = 1),
  expected_day_record_count INTEGER NOT NULL CHECK(expected_day_record_count = 1)
);

INSERT INTO migration_0042_post_guard(id,expected_task_count,expected_day_record_count)
SELECT 1,
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='task' AND state='published'
    AND schema_hash='fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6'),
  (SELECT COUNT(*) FROM model_definitions WHERE model_key='day_record' AND state='published'
    AND schema_hash='9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1');

DROP TABLE migration_0042_post_guard;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='42' WHERE key='schema_version';
