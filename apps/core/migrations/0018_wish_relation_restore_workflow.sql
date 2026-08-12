-- Preserve the Phase-2 restore fallback without reintroducing Wish-specific
-- runtime code. Wish v3 uses the bounded Workflow person-relation branch:
-- a claimed archived wish restores to open when its claimant is no longer an
-- active Person in the Space; otherwise the archived state is restored.

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_builtin_wish_v3',
  'wish',
  'wishes',
  3,
  'published',
  1,
  '{"access":["read","write"],"actions":{"archive":{"access":"write","guards":[{"errorCode":"WISH_ARCHIVED","field":"status","message":"Wish is already archived","op":"neq","value":"archived"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"archivedFromStatus":{"$ref":"record.status"},"status":"archived"}},"claim":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be claimed","op":"eq","value":"open"}],"policy":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"record.ownerPersonId"},"op":"neq","right":{"$ref":"actor.personId"}}]},"set":{"claimantPersonId":{"$ref":"actor.personId"},"claimedAt":{"$ref":"now"},"status":"claimed"}},"fulfill":{"access":"write","guards":[{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Wish cannot be fulfilled from its current state","op":"neq","value":"archived"},{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Wish cannot be fulfilled from its current state","op":"neq","value":"fulfilled"}],"policy":{"any":[{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},{"left":{"$ref":"record.claimantPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"set":{"fulfilledAt":{"$ref":"now"},"fulfilledByPersonId":{"$ref":"actor.personId"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_INVALID_STATE","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"claimantPersonId":null,"claimedAt":null,"fulfilledAt":null,"fulfilledByPersonId":null,"status":"open"}},"restore":{"access":"write","branches":[{"set":{"archivedFromStatus":null,"claimantPersonId":null,"claimedAt":null,"status":"open"},"when":{"all":[{"field":"archivedFromStatus","op":"eq","value":"claimed"},{"active":false,"personRelation":"claimantPersonId"}]}}],"guards":[{"errorCode":"WISH_NOT_ARCHIVED","field":"status","message":"Wish is not archived","op":"eq","value":"archived"}],"policy":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"archivedFromStatus":null,"status":{"$ref":"record.archivedFromStatus"}}},"unclaim":{"access":"write","guards":[{"errorCode":"WISH_CLAIMANT_REQUIRED","field":"status","message":"Only a claimed wish can be released","op":"eq","value":"claimed"}],"policy":{"left":{"$ref":"record.claimantPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"set":{"claimantPersonId":null,"claimedAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"display":{"plural":"Wishes","singular":"Wish"},"fields":{"archivedFromStatus":{"nullable":true,"readOnly":true,"type":"enum","values":["open","claimed","fulfilled"]},"claimantPersonId":{"nullable":true,"readOnly":true,"type":"person"},"claimedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"description":{"maxLength":5000,"nullable":true,"type":"text"},"desiredDate":{"nullable":true,"type":"date"},"fulfilledAt":{"nullable":true,"readOnly":true,"type":"datetime"},"fulfilledByPersonId":{"nullable":true,"readOnly":true,"type":"person"},"ownerPersonId":{"immutable":true,"required":true,"type":"person"},"status":{"required":true,"type":"enum","values":["open","claimed","fulfilled","archived"]},"title":{"maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"read":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"update":{"all":[{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},{"left":{"$ref":"record.status"},"op":"neq","right":{"value":"archived"}}]}},"query":{"filterable":["status","ownerPersonId","claimantPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"route":"wishes"}',
  'ce8e86a792e0bf6b7ee8bf70324ef51d28f531989b3f503d0408e24798c99fc1',
  'compatible',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace bootstrap'
);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='18' WHERE key='schema_version';
