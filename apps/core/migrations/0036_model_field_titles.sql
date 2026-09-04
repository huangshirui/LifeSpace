-- Converge the canonical baseline Model Definitions after adding JSON Schema-aligned
-- human-facing field titles.
--
-- Field title is optional in Model Definition v1 so historical published definitions
-- remain valid. The shipped baseline catalog is authoritative for current semantics,
-- therefore each changed model receives a new compatible immutable Registry version.
-- No typed-storage shape or existing resource data changes are required.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published' AND schema_hash<>'1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_task_field_titles_20260904','task','tasks',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='task'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_CANCELLED","field":"status","message":"Task is already cancelled","op":"neq","value":"cancelled"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","title":"Assignees","type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"title":"Completed At","type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"title":"Completed By","type":"string"},"completedByType":{"nullable":true,"readOnly":true,"title":"Completed By Type","type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"title":"Due Date","type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"status":{"description":"Current lifecycle state of the task.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  '1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='task' AND state='published' AND schema_hash='1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published' AND schema_hash<>'4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_wish_field_titles_20260904','wish','wishes',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='wish'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"fulfill":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be fulfilled","op":"eq","value":"open"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":{"$ref":"now"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_NOT_FULFILLED","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"description":"An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。","display":{"plural":"Wishes","singular":"Wish"},"fields":{"description":{"description":"Optional detail about the aspiration and why it is desired.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"desiredDate":{"description":"A hoped-for date, not a committed task deadline or scheduled event time.","nullable":true,"title":"Desired Date","type":"date"},"fulfilledAt":{"description":"When the wish was marked fulfilled.","nullable":true,"readOnly":true,"title":"Fulfilled At","type":"datetime"},"ownerPersonId":{"description":"The person whose aspiration this is.","immutable":true,"required":true,"title":"Owner","type":"person"},"status":{"description":"Whether the wish is still waiting to happen or has been fulfilled.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["open","fulfilled"]},"title":{"description":"A concise statement of the aspiration or desired outcome.","maxLength":100,"minLength":1,"required":true,"title":"Title","type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}}, {"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"read":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"update":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}},"query":{"filterable":["status","ownerPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"route":"wishes"}',
  '4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='wish' AND state='published' AND schema_hash='4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='day_record' AND state='published' AND schema_hash<>'7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_day_record_field_titles_20260904','day_record','day-records',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='day_record'),0)+1,
  'published',1,
  '{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ARCHIVED","field":"status","message":"Day record is already archived","op":"neq","value":"archived"}],"set":{"status":"archived"}},"restore":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ALREADY_ACTIVE","field":"status","message":"Day record is already active","op":"neq","value":"active"}],"set":{"status":"active"}}},"capabilities":{"temporal":{"anchorDateField":"anchorDate","attentionAfterDaysField":"attentionAfterDays","attentionBeforeDaysField":"attentionBeforeDays","cycleDaysField":"cycleDays","kindField":"kind","occurrences":true,"statusField":"status","subjectPersonField":"subjectPersonId"}},"definitionVersion":1,"description":"A date-anchored tracker for counting elapsed days, counting down to a date, or representing a recurring/cycle interval. Use for since/until counters, milestones anchored to a date, streaks, and cycle tracking. Do not use for ordinary appointments, one-off calendar occurrences, or concrete to-dos. Examples: 从今天开始戒糖；距离生日还有多少天；每28天一个周期。","display":{"plural":"Day Records","singular":"Day Record"},"fields":{"anchorDate":{"description":"The calendar date that anchors the elapsed, countdown, or cycle calculation.","required":true,"title":"Anchor Date","type":"date"},"attentionAfterDays":{"minimum":1,"nullable":true,"title":"Attention After Days","type":"integer"},"attentionBeforeDays":{"minimum":0,"nullable":true,"title":"Attention Before Days","type":"integer"},"cycleDays":{"description":"Length in days for a recurring cycle.","minimum":1,"nullable":true,"title":"Cycle Days","type":"integer"},"description":{"description":"Optional context about the tracked date or cycle.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"icon":{"maxLength":50,"nullable":true,"title":"Icon","type":"string"},"kind":{"description":"Tracker mode: elapsed since anchorDate, countdown until anchorDate, or recurring cycle.","immutable":true,"required":true,"title":"Kind","type":"enum","values":["elapsed","countdown","cycle"]},"name":{"description":"The milestone, streak, countdown, or cycle being tracked.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"status":{"readOnly":true,"required":true,"title":"Status","type":"enum","values":["active","archived"]},"subjectPersonId":{"description":"Optional person the tracked date or cycle belongs to.","nullable":true,"title":"Subject","type":"person"}},"key":"day_record","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["kind","status","subjectPersonId","anchorDate"],"searchable":["name","description"],"sortable":["anchorDate","name"]},"route":"day-records"}',
  '7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='day_record' AND state='published' AND schema_hash='7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published' AND schema_hash<>'66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_catalog_event_field_titles_20260904','event','events',
  COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='event'),0)+1,
  'published',1,
  '{"access":["read","write"],"capabilities":{"calendar":{"allDayEndExclusiveField":"endDateExclusive","allDayField":"isAllDay","allDayStartField":"startDate","attendeePersonField":"attendeePersonIds","endTimezoneField":"endTimezone","startTimezoneField":"startTimezone","timedEndField":"endAt","timedStartField":"startAt"}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。","display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"description":"People attending or participating in the occurrence.","title":"Attendees","type":"person_list"},"description":{"description":"Optional details about the occurrence.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"endAt":{"description":"End instant for a timed occurrence when explicitly known.","nullable":true,"title":"End","type":"datetime"},"endDateExclusive":{"description":"Exclusive end date for an all-day occurrence.","nullable":true,"title":"End Date (Exclusive)","type":"date"},"endTimezone":{"nullable":true,"title":"End Time Zone","type":"timezone"},"isAllDay":{"description":"Whether the occurrence is date-only rather than at a specific time.","required":true,"title":"All Day","type":"boolean"},"location":{"description":"Where the occurrence happens, when explicitly provided.","maxLength":500,"nullable":true,"title":"Location","type":"string"},"startAt":{"description":"Start instant for a timed occurrence.","nullable":true,"title":"Start","type":"datetime"},"startDate":{"description":"Start date for an all-day occurrence.","nullable":true,"title":"Start Date","type":"date"},"startTimezone":{"nullable":true,"title":"Start Time Zone","type":"timezone"},"status":{"description":"Current lifecycle state of the event.","required":true,"title":"Status","type":"enum","values":["active","cancelled"]},"summary":{"description":"A concise name for the calendar occurrence.","maxLength":100,"minLength":1,"required":true,"title":"Summary","type":"string"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","isAllDay","startAt","startDate","attendeePersonIds"],"searchable":["summary","description","location"],"sortable":["startAt","startDate","summary"]},"route":"events"}',
  '66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
WHERE NOT EXISTS(
  SELECT 1 FROM model_definitions
  WHERE model_key='event' AND state='published' AND schema_hash='66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4'
);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='36' WHERE key='schema_version';
