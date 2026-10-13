-- Recurrence scheduling projection and stable generated Task identity (#338).
ALTER TABLE mdl_task ADD COLUMN subject TEXT CHECK(subject IS NULL OR (json_valid(subject) AND json_type(subject)='object'));
ALTER TABLE mdl_task ADD COLUMN recurrenceOccurrenceId TEXT;
CREATE UNIQUE INDEX idx_mdl_task_recurrence_occurrence ON mdl_task(recurrenceOccurrenceId) WHERE recurrenceOccurrenceId IS NOT NULL;
CREATE TABLE recurrence_plans (
 plan_record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id), model_key TEXT NOT NULL,
 revision INTEGER NOT NULL, config_json TEXT NOT NULL, version INTEGER NOT NULL,
 principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, application_id TEXT NOT NULL,
 scopes_json TEXT NOT NULL, next_materialize_date TEXT, cursor_date TEXT,
 current_occurrence_id TEXT, anchor_date TEXT, stopped INTEGER NOT NULL DEFAULT 0, next_materialize_at TEXT
);
CREATE INDEX idx_recurrence_due ON recurrence_plans(next_materialize_at,plan_record_id) WHERE next_materialize_at IS NOT NULL;
CREATE INDEX idx_recurrence_space_due ON recurrence_plans(space_id,next_materialize_at,plan_record_id) WHERE next_materialize_at IS NOT NULL;
CREATE TABLE recurrence_occurrences (
 id TEXT PRIMARY KEY, plan_record_id TEXT NOT NULL REFERENCES recurrence_plans(plan_record_id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, identity TEXT NOT NULL, due_date TEXT NOT NULL,
 task_record_id TEXT NOT NULL UNIQUE REFERENCES resource_records(id),
 predecessor_id TEXT REFERENCES recurrence_occurrences(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('active','completed','cancelled','skipped')),
 anchor_date TEXT, UNIQUE(plan_record_id,revision,identity)
);
CREATE UNIQUE INDEX idx_recurrence_predecessor ON recurrence_occurrences(predecessor_id,revision) WHERE predecessor_id IS NOT NULL;
CREATE INDEX idx_recurrence_active_future ON recurrence_occurrences(plan_record_id,due_date) WHERE outcome='active';
CREATE INDEX idx_recurrence_plan_occurrences ON recurrence_occurrences(plan_record_id,revision,due_date);
CREATE TABLE recurrence_commit_guards (token TEXT PRIMARY KEY,record_id TEXT NOT NULL);
CREATE TRIGGER recurrence_commit_guard BEFORE INSERT ON recurrence_commit_guards
WHEN NOT EXISTS(SELECT 1 FROM resource_records WHERE id=NEW.record_id AND mutation_token=NEW.token AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'RECURRENCE_VERSION_CONFLICT'); END;
CREATE TABLE recurrence_state_guards (plan_record_id TEXT PRIMARY KEY,expected_version INTEGER NOT NULL);
CREATE TRIGGER recurrence_state_guard BEFORE INSERT ON recurrence_state_guards
WHEN NOT EXISTS(SELECT 1 FROM recurrence_plans WHERE plan_record_id=NEW.plan_record_id AND version=NEW.expected_version)
BEGIN SELECT RAISE(ABORT,'RECURRENCE_VERSION_CONFLICT'); END;
CREATE TABLE recurrence_generation_guards (token TEXT PRIMARY KEY,space_id TEXT NOT NULL,model_key TEXT NOT NULL,principal_type TEXT NOT NULL,principal_id TEXT NOT NULL,application_id TEXT NOT NULL);
CREATE TRIGGER recurrence_generation_guard BEFORE INSERT ON recurrence_generation_guards
WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id AND deleted_at IS NULL)
 OR EXISTS(SELECT value FROM json_each(json_array(NEW.model_key,'task')) required
   WHERE NOT EXISTS(SELECT 1 FROM application_model_access WHERE application_id=NEW.application_id AND model_key=required.value AND max_access IN ('write','manage'))
   OR NOT (EXISTS(SELECT 1 FROM space_memberships WHERE NEW.principal_type='user' AND space_id=NEW.space_id AND user_id=NEW.principal_id AND deleted_at IS NULL AND role IN ('owner','admin','editor'))
     OR EXISTS(SELECT 1 FROM data_grants WHERE source_space_id=NEW.space_id AND grantee_type=NEW.principal_type AND grantee_id=NEW.principal_id AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')) AND permission IN ('write','manage') AND ((resource_type='space' AND resource_id IS NULL) OR (resource_type='model' AND resource_id=required.value)))))
BEGIN SELECT RAISE(ABORT,'RECURRENCE_AUTHORITY_UNAVAILABLE'); END;
UPDATE model_definitions SET state='superseded' WHERE model_key='task' AND state='published';
INSERT INTO model_definitions(id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot) SELECT 'mdl_task_recurrence_20261012','task','task',MAX(version)+1,'published',1,'{"access":["read","write"],"actions":{"cancel":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_CANCELLED","field":"status","message":"Task is already cancelled","op":"neq","value":"cancelled"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}},"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}},"skip-occurrence":{"access":"write","guards":[{"errorCode":"ACTION_NOT_AVAILABLE","field":"recurrenceOccurrenceId","message":"Only generated Tasks have a recurrence occurrence","op":"neq","value":null}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"cancelled"}}},"defaults":{"status":"pending"},"definitionVersion":1,"description":"Actionable work that someone intends or needs to complete. Use for chores, errands, reminders, follow-ups, purchases, submissions, calls, and other concrete to-dos. A due date is a deadline, not a scheduled time block. Do not use for an event merely because it has a date, or for a future aspiration with no concrete commitment. Examples: 明天交电费；提醒我买牛奶；周五前提交报告。","display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"description":"People responsible for completing the task.","title":"Assignees","type":"person_list"},"completedAt":{"description":"When the task was completed, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed At","type":"datetime"},"completedById":{"description":"Identifier of the Actor that completed the task, set by the authoritative completion Action.","maxLength":100,"nullable":true,"readOnly":true,"title":"Completed By","type":"string"},"completedByType":{"description":"Type of Actor that completed the task, set by the authoritative completion Action.","nullable":true,"readOnly":true,"title":"Completed By Type","type":"enum","values":["user","service","device","agent"]},"description":{"description":"Supporting details about how or why to complete the task.","maxLength":5000,"nullable":true,"title":"Description","type":"text"},"dueDate":{"description":"The deadline date for completing the task, not a calendar time block.","nullable":true,"title":"Due Date","type":"date"},"name":{"description":"The concrete action or to-do to complete.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"},"recurrenceOccurrenceId":{"description":"Platform-owned stable occurrence identity for generated tasks.","immutable":true,"nullable":true,"readOnly":true,"title":"Recurrence Occurrence","type":"string"},"status":{"description":"Current lifecycle state of the task.","readOnly":true,"required":true,"title":"Status","type":"enum","values":["pending","completed","cancelled"]},"subject":{"description":"Business subject of the work: a Space Person or native Record.","nullable":true,"title":"Subject","type":"entity_ref"}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"semanticRelations":{"outgoing":["generated_from"]}}','8628fc7c392776e943f9279d1841be17983d092f7e3045dce6a976dde9ad39de','compatible','service','svc_lifespace_bootstrap','LifeSpace schema 57 migration' FROM model_definitions WHERE model_key='task';
UPDATE model_registry_state SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='57' WHERE key='schema_version';
