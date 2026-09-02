-- Converge fresh/deployed baseline model publication state to the single
-- editable catalog in apps/core/model-catalog/baseline-models.json.
--
-- Historical Model Definition rows remain immutable. Only a currently
-- published definition whose schema hash differs from the canonical catalog
-- is superseded, then a new compatible version is published. Environments
-- already converged by the earlier semantic publisher remain unchanged.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published' AND schema_hash<>'3c56f1448340162279be544e16ac82e06c1aefe66a08e428b7f95ba319ab1ed2';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_task_20260902','task','tasks',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='task'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"type":"string"},"completedByType":{"nullable":true,"readOnly":true,"type":"enum","values":["user","service","device"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"description":"Current lifecycle state of the task.","required":true,"type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  '3c56f1448340162279be544e16ac82e06c1aefe66a08e428b7f95ba319ab1ed2','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='task' AND state='published' AND schema_hash='3c56f1448340162279be544e16ac82e06c1aefe66a08e428b7f95ba319ab1ed2'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='day_record' AND state='published' AND schema_hash<>'4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_day_record_20260902','day_record','day-records',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='day_record'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ARCHIVED","field":"status","message":"Day record is already archived","op":"neq","value":"archived"}],"set":{"status":"archived"}},"restore":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ALREADY_ACTIVE","field":"status","message":"Day record is already active","op":"neq","value":"active"}],"set":{"status":"active"}}},"capabilities":{"temporal":{"anchorDateField":"anchorDate","attentionAfterDaysField":"attentionAfterDays","attentionBeforeDaysField":"attentionBeforeDays","cycleDaysField":"cycleDays","kindField":"kind","occurrences":true,"statusField":"status","subjectPersonField":"subjectPersonId"}},"definitionVersion":1,"description":"A date-anchored tracker for counting elapsed days, counting down to a date, or representing a recurring/cycle interval. Use for since/until counters, milestones anchored to a date, streaks, and cycle tracking. Do not use for ordinary appointments, one-off calendar occurrences, or concrete to-dos. Examples: 从今天开始戒糖；距离生日还有多少天；每28天一个周期。","display":{"plural":"Day Records","singular":"Day Record"},"fields":{"anchorDate":{"description":"The calendar date that anchors the elapsed, countdown, or cycle calculation.","required":true,"type":"date"},"attentionAfterDays":{"minimum":1,"nullable":true,"type":"integer"},"attentionBeforeDays":{"minimum":0,"nullable":true,"type":"integer"},"cycleDays":{"description":"Length in days for a recurring cycle.","minimum":1,"nullable":true,"type":"integer"},"description":{"description":"Optional context about the tracked date or cycle.","maxLength":5000,"nullable":true,"type":"text"},"icon":{"maxLength":50,"nullable":true,"type":"string"},"kind":{"description":"Tracker mode: elapsed since anchorDate, countdown until anchorDate, or recurring cycle.","immutable":true,"required":true,"type":"enum","values":["elapsed","countdown","cycle"]},"name":{"description":"The milestone, streak, countdown, or cycle being tracked.","maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"readOnly":true,"required":true,"type":"enum","values":["active","archived"]},"subjectPersonId":{"description":"Optional person the tracked date or cycle belongs to.","nullable":true,"type":"person"}},"key":"day_record","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["kind","status","subjectPersonId","anchorDate"],"searchable":["name","description"],"sortable":["anchorDate","name"]},"route":"day-records"}',
  '4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='day_record' AND state='published' AND schema_hash='4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published' AND schema_hash<>'6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_event_20260902','event','events',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='event'),0)+1,
  'published',1,
  '{"access":["read","write"],"capabilities":{"calendar":{"allDayEndExclusiveField":"endDateExclusive","allDayField":"isAllDay","allDayStartField":"startDate","attendeePersonField":"attendeePersonIds","endTimezoneField":"endTimezone","startTimezoneField":"startTimezone","timedEndField":"endAt","timedStartField":"startAt"}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。","display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"description":"People attending or participating in the occurrence.","type":"person_list"},"description":{"description":"Optional details about the occurrence.","maxLength":5000,"nullable":true,"type":"text"},"endAt":{"description":"End instant for a timed occurrence when explicitly known.","nullable":true,"type":"datetime"},"endDateExclusive":{"description":"Exclusive end date for an all-day occurrence.","nullable":true,"type":"date"},"endTimezone":{"nullable":true,"type":"timezone"},"isAllDay":{"description":"Whether the occurrence is date-only rather than at a specific time.","required":true,"type":"boolean"},"location":{"description":"Where the occurrence happens, when explicitly provided.","maxLength":500,"nullable":true,"type":"string"},"startAt":{"description":"Start instant for a timed occurrence.","nullable":true,"type":"datetime"},"startDate":{"description":"Start date for an all-day occurrence.","nullable":true,"type":"date"},"startTimezone":{"nullable":true,"type":"timezone"},"status":{"description":"Current lifecycle state of the event.","required":true,"type":"enum","values":["active","cancelled"]},"summary":{"description":"A concise name for the calendar occurrence.","maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","isAllDay","startAt","startDate","attendeePersonIds"],"searchable":["summary","description","location"],"sortable":["startAt","startDate","summary"]},"route":"events"}',
  '6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='event' AND state='published' AND schema_hash='6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad'
);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='33' WHERE key='schema_version';
