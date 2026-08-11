-- Model defaults are part of the final metadata-runtime create contract.
-- Preserve published-version immutability by superseding the proving versions
-- instead of rewriting their definition_json in place.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='task' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_builtin_task_v2','task','tasks',2,'published',1,
  '{"access":["read","write"],"actions":{"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"defaults":{"status":"pending"},"definitionVersion":1,"display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"type":"string"},"completedByType":{"nullable":true,"readOnly":true,"type":"enum","values":["user","service","device"]},"description":{"maxLength":5000,"nullable":true,"type":"text"},"dueDate":{"nullable":true,"type":"date"},"name":{"maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"required":true,"type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  '97053c8fd9e6f90ef9881cfbabc34d081a7ebbbaabc21143343aa9b9e57faa76','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_builtin_wish_v2','wish','wishes',2,'published',1,
  '{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"WISH_ARCHIVED","field":"status","message":"Wish is already archived","op":"neq","value":"archived"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"archivedFromStatus":{"$ref":"record.status"},"status":"archived"}},"claim":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be claimed","op":"eq","value":"open"}],"policy":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"record.ownerPersonId"},"op":"neq","right":{"$ref":"actor.personId"}}]},"set":{"claimantPersonId":{"$ref":"actor.personId"},"claimedAt":{"$ref":"now"},"status":"claimed"}},"fulfill":{"access":"write","guards":[{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Wish cannot be fulfilled from its current state","op":"neq","value":"archived"},{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Wish cannot be fulfilled from its current state","op":"neq","value":"fulfilled"}],"policy":{"any":[{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},{"left":{"$ref":"record.claimantPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"set":{"fulfilledAt":{"$ref":"now"},"fulfilledByPersonId":{"$ref":"actor.personId"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"claimantPersonId":null,"claimedAt":null,"fulfilledAt":null,"fulfilledByPersonId":null,"status":"open"}},"restore":{"access":"write","guards":[{"errorCode":"WISH_NOT_ARCHIVED","field":"status","message":"Wish is not archived","op":"eq","value":"archived"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"archivedFromStatus":null,"status":{"$ref":"record.archivedFromStatus"}}},"unclaim":{"access":"write","guards":[{"errorCode":"WISH_CLAIMANT_REQUIRED","field":"status","message":"Only a claimed wish can be released","op":"eq","value":"claimed"}],"policy":{"left":{"$ref":"record.claimantPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"claimantPersonId":null,"claimedAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"display":{"plural":"Wishes","singular":"Wish"},"fields":{"archivedFromStatus":{"nullable":true,"readOnly":true,"type":"enum","values":["open","claimed","fulfilled"]},"claimantPersonId":{"nullable":true,"readOnly":true,"type":"person"},"claimedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"description":{"maxLength":5000,"nullable":true,"type":"text"},"desiredDate":{"nullable":true,"type":"date"},"fulfilledAt":{"nullable":true,"readOnly":true,"type":"datetime"},"fulfilledByPersonId":{"nullable":true,"readOnly":true,"type":"person"},"ownerPersonId":{"immutable":true,"required":true,"type":"person"},"status":{"required":true,"type":"enum","values":["open","claimed","fulfilled","archived"]},"title":{"maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"read":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"update":{"all":[{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},{"left":{"$ref":"record.status"},"op":"neq","right":{"value":"archived"}}]}},"query":{"filterable":["status","ownerPersonId","claimantPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"route":"wishes"}',
  'e2c2f996be6e548ace513d67b6ae529d49c9d9f35da9a74aab8cc0ef56ed589c','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
);

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='event' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_builtin_event_v2','event','events',2,'published',1,
  '{"access":["read","write"],"capabilities":{"calendar":{"allDayEndExclusiveField":"endDateExclusive","allDayField":"isAllDay","allDayStartField":"startDate","attendeePersonField":"attendeePersonIds","endTimezoneField":"endTimezone","startTimezoneField":"startTimezone","timedEndField":"endAt","timedStartField":"startAt"}},"defaults":{"status":"active"},"definitionVersion":1,"display":{"plural":"Events","singular":"Event"},"fields":{"attendeePersonIds":{"type":"person_list"},"description":{"maxLength":5000,"nullable":true,"type":"text"},"endAt":{"nullable":true,"type":"datetime"},"endDateExclusive":{"nullable":true,"type":"date"},"endTimezone":{"nullable":true,"type":"timezone"},"isAllDay":{"required":true,"type":"boolean"},"location":{"maxLength":500,"nullable":true,"type":"string"},"startAt":{"nullable":true,"type":"datetime"},"startDate":{"nullable":true,"type":"date"},"startTimezone":{"nullable":true,"type":"timezone"},"status":{"required":true,"type":"enum","values":["active","cancelled"]},"summary":{"maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"event","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","isAllDay","startAt","startDate","attendeePersonIds"],"searchable":["summary","description","location"],"sortable":["startAt","startDate","summary"]},"route":"events"}',
  '4d2c76486402fdb48d4956c68dcd413cbc549075d192760786100380f7bd9522','compatible',
  'service','svc_lifespace_bootstrap','LifeSpace bootstrap'
);

-- Model publication itself never grants an application access. These entries
-- explicitly declare the four baseline models HomeMew is allowed to use.
INSERT OR IGNORE INTO application_model_access(
  application_id,model_key,max_access,created_by_type,created_by_id
) VALUES
  ('homemew-miniprogram','task','write','service','svc_lifespace_bootstrap'),
  ('homemew-miniprogram','wish','write','service','svc_lifespace_bootstrap'),
  ('homemew-miniprogram','day_record','write','service','svc_lifespace_bootstrap'),
  ('homemew-miniprogram','event','write','service','svc_lifespace_bootstrap');

UPDATE application_model_access
SET max_access='write',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE application_id='homemew-miniprogram'
  AND model_key IN ('task','wish','day_record','event')
  AND max_access='read';

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='17' WHERE key='schema_version';
