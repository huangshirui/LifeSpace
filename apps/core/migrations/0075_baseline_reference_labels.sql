-- Schema 75: four baseline models gain canonical record reference labels.
-- Classification: BREAKING semantic Reference Projection (ID fallback -> declared field).
-- Record fields, typed storage and existing Semantic Relation edges are unchanged.
-- Historical Model Registry rows remain immutable. Requires schema 74.
-- Rollback: verified D1 snapshot + previous compatible Worker/consumers.
CREATE TABLE _schema75_reference_label_guard (
 schema_version INTEGER NOT NULL CHECK(schema_version=74),
 published_count INTEGER NOT NULL CHECK(published_count=4),
 old_hash_count INTEGER NOT NULL CHECK(old_hash_count=4)
);
INSERT INTO _schema75_reference_label_guard(schema_version,published_count,old_hash_count)
SELECT
 (SELECT CAST(value AS INTEGER) FROM schema_metadata WHERE key='schema_version'),
 (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND model_key IN ('task','wish','day_record','event')),
 (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND ((model_key='task' AND schema_hash='8628fc7c392776e943f9279d1841be17983d092f7e3045dce6a976dde9ad39de') OR (model_key='wish' AND schema_hash='772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934') OR (model_key='day_record' AND schema_hash='3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7') OR (model_key='event' AND schema_hash='7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6')));
DROP TABLE _schema75_reference_label_guard;

-- task: name is now the canonical reference label.
UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published' AND schema_hash='8628fc7c392776e943f9279d1841be17983d092f7e3045dce6a976dde9ad39de';

INSERT INTO model_definitions (
 id,model_key,route_segment,version,state,definition_version,definition_json,
 schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_task_20261027_reference_label','task','task',
 COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='task'),0)+1,
 'published',1,'{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_CANCELLED","field":"status","message":"Task is already cancelled","op":"neq","value":"cancelled"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}},"skip-occurrence":{"access":"write","guards":[{"errorCode":"ACTION_NOT_AVAILABLE","field":"recurrenceOccurrenceId","message":"Only generated Tasks have a recurrence occurrence","op":"neq","value":null}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","title":"Assignees","type":"person_list"},"completedAt":{"description":"When the task was completed, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed At","type":"datetime"},"completedById":{"description":"Identifier of the Actor that completed the task, set by the authoritative completion Action.","maxLength":100,"nullable":true,"readOnly":true,"title":"Completed By","type":"string"},"completedByType":{"description":"Type of Actor that completed the task, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed By Type","type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"title":"Due Date","type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"recurrenceOccurrenceId":{"description":"Platform-owned stable occurrence identity for generated tasks.","immutable":true,"nullable":true,"readOnly":true,"title":"Recurrence Occurrence","type":"string"},"status":{"description":"Current lifecycle state of the task.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["pending","completed","cancelled"]},"subject":{"description":"Business subject of the work: a Space Person or native Record.","nullable":true,"title":"Subject","type":"entity_ref"}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"referenceLabel":{"field":"name"},"semanticRelations":{"outgoing":["generated_from"]}}','c1aac009972a2c5676f07ce9df610bb089569abb7c0792ead3cca4c35bb293d4','breaking',
 'service','svc_lifespace_bootstrap','LifeSpace schema 75 reference label convergence',
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM model_definitions WHERE model_key='task' AND state='superseded' AND schema_hash='8628fc7c392776e943f9279d1841be17983d092f7e3045dce6a976dde9ad39de');

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='task' AND state='published')
WHERE model_key='task';

-- wish: title is now the canonical reference label.
UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published' AND schema_hash='772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934';

INSERT INTO model_definitions (
 id,model_key,route_segment,version,state,definition_version,definition_json,
 schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_wish_20261027_reference_label','wish','wish',
 COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='wish'),0)+1,
 'published',1,'{"access":["read","write"],"actions":{"fulfill":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be fulfilled","op":"eq","value":"open"}],"policy":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":{"$ref":"now"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_NOT_FULFILLED","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"description":"An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。","display":{"plural":"Wishes","singular":"Wish"},"fields":{"description":{"description":"Optional detail about the aspiration and why it is desired.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"desiredDate":{"description":"A hoped-for date, not a committed task deadline or scheduled event time.","nullable":true,"title":"Desired Date","type":"date"},"fulfilledAt":{"description":"When the wish was marked fulfilled.","nullable":true,"readOnly":true,"title":"Fulfilled At","type":"datetime"},"ownerPersonId":{"description":"The person whose aspiration this is.","immutable":true,"required":true,"title":"Owner","type":"person"},"status":{"description":"Whether the wish is still waiting to happen or has been fulfilled.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["open","fulfilled"]},"title":{"description":"A concise statement of the aspiration or desired outcome.","maxLength":100,"minLength":1,"required":true,"title":"Title","type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}},"read":{"left":{"$ref":"principal.personId"},"op":"neq","right":{"value":null}},"update":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"principal.personId"}}},"query":{"filterable":["status","ownerPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"referenceLabel":{"field":"title"}}','70a20b920faa7bc077e02fc2328f98293d9972c8eceed83cf2516645268a60a6','breaking',
 'service','svc_lifespace_bootstrap','LifeSpace schema 75 reference label convergence',
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM model_definitions WHERE model_key='wish' AND state='superseded' AND schema_hash='772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934');

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='wish' AND state='published')
WHERE model_key='wish';

-- day_record: name is now the canonical reference label.
UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='day_record' AND state='published' AND schema_hash='3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7';

INSERT INTO model_definitions (
 id,model_key,route_segment,version,state,definition_version,definition_json,
 schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_day_record_20261027_reference_label','day_record','day_record',
 COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='day_record'),0)+1,
 'published',1,'{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ARCHIVED","field":"status","message":"Day record is already archived","op":"neq","value":"archived"}],"set":{"status":"archived"}},"restore":{"access":"write","guards":[{"errorCode":"DAY_RECORD_ALREADY_ACTIVE","field":"status","message":"Day record is already active","op":"neq","value":"active"}],"set":{"status":"active"}}},"capabilities":{"temporal":{"anchorDateField":"anchorDate","attentionAfterDaysField":"attentionAfterDays","attentionBeforeDaysField":"attentionBeforeDays","cycleDaysField":"cycleDays","kindField":"kind","occurrences":true,"statusField":"status","subjectPersonField":"subjectPersonId"}},"definitionVersion":1,"description":"A date-anchored tracker for counting elapsed days, counting down to a date, or representing a recurring/cycle interval. Use for since/until counters, milestones anchored to a date, streaks, and cycle tracking. Do not use for ordinary appointments, one-off calendar occurrences, or concrete to-dos. Examples: 从今天开始戒糖；距离生日还有多少天；每28天一个周期。","display":{"plural":"Day Records","singular":"Day Record"},"fields":{"anchorDate":{"description":"The calendar date that anchors the elapsed, countdown, or cycle calculation.","required":true,"title":"Anchor Date","type":"date"},"attentionAfterDays":{"description":"Number of days after the anchor date when the record should enter an attention window.","minimum":1,"nullable":true,"title":"Attention After Days","type":"integer"},"attentionBeforeDays":{"description":"Number of days before the anchor date when the record should enter an attention window.","minimum":0,"nullable":true,"title":"Attention Before Days","type":"integer"},"cycleDays":{"description":"Length in days for a recurring cycle.","minimum":1,"nullable":true,"title":"Cycle Days","type":"integer"},"description":{"description":"Optional context about the tracked date or cycle.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"kind":{"description":"Tracker mode: elapsed since anchorDate, countdown until anchorDate, or recurring cycle.","immutable":true,"required":true,"title":"Kind","type":"enum","values":["elapsed","countdown","cycle"]},"name":{"description":"The milestone, streak, countdown, or cycle being tracked.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"status":{"description":"Current lifecycle state of the day record.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["active","archived"]},"subjectPersonId":{"description":"Optional person the tracked date or cycle belongs to.","nullable":true,"title":"Subject","type":"person"}},"key":"day_record","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["kind","status","subjectPersonId","anchorDate"],"searchable":["name","description"],"sortable":["anchorDate","name"]},"referenceLabel":{"field":"name"}}','323660d43816e55b9789fe4dd7a071ea138f6fdd5354401b0d7317ffba0e4a5e','breaking',
 'service','svc_lifespace_bootstrap','LifeSpace schema 75 reference label convergence',
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM model_definitions WHERE model_key='day_record' AND state='superseded' AND schema_hash='3a1d8cfdeaeb17b336359c4b2d7e7c9b5c6dda0e547cbb7622f60b4390f39dc7');

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='day_record' AND state='published')
WHERE model_key='day_record';

-- event: summary is now the canonical reference label.
UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published' AND schema_hash='7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6';

INSERT INTO model_definitions (
 id,model_key,route_segment,version,state,definition_version,definition_json,
 schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at
)
SELECT 'mdl_catalog_event_20261027_reference_label','event','event',
 COALESCE((SELECT MAX(version) FROM model_definitions WHERE model_key='event'),0)+1,
 'published',1,'{"access":["read","write"],"capabilities":{"calendar":{"attendeePersonField":"attendeePersonIds","rangeField":"when"}},"defaults":{"status":"active"},"definitionVersion":1,"description":"A calendar occurrence that happens or is planned for a specific date or time and may occupy time or involve attendance or a location. Use for meetings, appointments, classes, matches, meals, celebrations, and other things that occur. Do not use merely because a task has a deadline. Examples: 周六上午十点足球比赛；明晚七点和王老师吃饭；8月30日体检。","display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"description":"People attending or participating in the occurrence.","title":"Attendees","type":"person_list"},"description":{"description":"Optional details about the occurrence.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"location":{"description":"Where the occurrence happens, when explicitly provided.","nullable":true,"title":"Location","type":"location"},"status":{"description":"Current lifecycle state of the event.","required":true,"title":"Status","type":"enum","values":["active","cancelled"]},"summary":{"description":"A concise name for the calendar occurrence.","maxLength":100,"minLength":1,"required":true,"title":"Summary","type":"string"},"when":{"description":"When the occurrence happens. Use the date variant for all-day/date-only events and the instant variant for timed events.","required":true,"title":"When","type":"temporal_range"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","when","attendeePersonIds","location"],"searchable":["summary","description","location"],"sortable":["when","summary"]},"referenceLabel":{"field":"summary"}}','dbf441f1f8203ebec0e16b2d6569b7606764b924540efd7bad30fb1258a7b270','breaking',
 'service','svc_lifespace_bootstrap','LifeSpace schema 75 reference label convergence',
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM model_definitions WHERE model_key='event' AND state='superseded' AND schema_hash='7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6');

UPDATE resource_records
SET model_version=(SELECT version FROM model_definitions WHERE model_key='event' AND state='published')
WHERE model_key='event';

CREATE TABLE _schema75_reference_label_postflight (
 published_count INTEGER NOT NULL CHECK(published_count=4),
 new_hash_count INTEGER NOT NULL CHECK(new_hash_count=4),
 version_count INTEGER NOT NULL CHECK(version_count=0)
);
INSERT INTO _schema75_reference_label_postflight(published_count,new_hash_count,version_count)
SELECT
 (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND model_key IN ('task','wish','day_record','event')),
 (SELECT COUNT(*) FROM model_definitions WHERE state='published' AND ((model_key='task' AND schema_hash='c1aac009972a2c5676f07ce9df610bb089569abb7c0792ead3cca4c35bb293d4' AND compatibility='breaking') OR (model_key='wish' AND schema_hash='70a20b920faa7bc077e02fc2328f98293d9972c8eceed83cf2516645268a60a6' AND compatibility='breaking') OR (model_key='day_record' AND schema_hash='323660d43816e55b9789fe4dd7a071ea138f6fdd5354401b0d7317ffba0e4a5e' AND compatibility='breaking') OR (model_key='event' AND schema_hash='dbf441f1f8203ebec0e16b2d6569b7606764b924540efd7bad30fb1258a7b270' AND compatibility='breaking'))),
 (SELECT COUNT(*) FROM resource_records r JOIN model_definitions m ON m.model_key=r.model_key AND m.state='published'
   WHERE r.model_key IN ('task','wish','day_record','event') AND r.model_version<>m.version);
DROP TABLE _schema75_reference_label_postflight;

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;
DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='75' WHERE key='schema_version';
