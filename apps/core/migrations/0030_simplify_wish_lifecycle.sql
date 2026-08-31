-- Simplify Wish to the minimal truth: an aspiration is either still open or fulfilled.
-- Claim and archive workflow state is removed from the published model.
--
-- Breaking migration normalization:
--   fulfilled, archived-from-fulfilled -> fulfilled
--   open, claimed, archived-from-open/claimed -> open

UPDATE mdl_wish
SET
  "status" = CASE
    WHEN "status" = 'fulfilled' OR ("status" = 'archived' AND "archivedFromStatus" = 'fulfilled')
      THEN 'fulfilled'
    ELSE 'open'
  END,
  "fulfilledAt" = CASE
    WHEN "status" = 'fulfilled' OR ("status" = 'archived' AND "archivedFromStatus" = 'fulfilled')
      THEN "fulfilledAt"
    ELSE NULL
  END;

DELETE FROM resource_relations
WHERE source_model_key='wish'
  AND field_key IN ('claimantPersonId','fulfilledByPersonId');

UPDATE model_definitions
SET state='superseded',superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_key='wish' AND state='published';

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
)
SELECT
  'mdl_builtin_wish_simple_lifecycle_20260831',
  'wish',
  'wishes',
  COALESCE(MAX(version),0)+1,
  'published',
  1,
  '{"access":["read","write"],"actions":{"fulfill":{"access":"write","guards":[{"errorCode":"WISH_NOT_OPEN","field":"status","message":"Only open wishes can be fulfilled","op":"eq","value":"open"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":{"$ref":"now"},"status":"fulfilled"}},"reopen":{"access":"write","guards":[{"errorCode":"WISH_NOT_FULFILLED","field":"status","message":"Only fulfilled wishes can be reopened","op":"eq","value":"fulfilled"}],"policy":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"set":{"fulfilledAt":null,"status":"open"}}},"defaults":{"status":"open"},"definitionVersion":1,"description":"An aspiration, desire, or hoped-for future experience or thing that the user wants but has not committed to as a concrete task or scheduled event. Use for bucket-list items, dreams, desired purchases, and hoped-for experiences. Never use Wish as a fallback merely because its schema is broad or another model has missing fields. Examples: 想去冰岛看极光；希望以后有一台房车；想学会潜水。","display":{"plural":"Wishes","singular":"Wish"},"fields":{"description":{"description":"Optional detail about the aspiration and why it is desired.","maxLength":5000,"nullable":true,"type":"text"},"desiredDate":{"description":"A hoped-for date, not a committed task deadline or scheduled event time.","nullable":true,"type":"date"},"fulfilledAt":{"description":"When the wish was marked fulfilled.","nullable":true,"readOnly":true,"type":"datetime"},"ownerPersonId":{"description":"The person whose aspiration this is.","immutable":true,"required":true,"type":"person"},"status":{"description":"Whether the wish is still waiting to happen or has been fulfilled.","required":true,"type":"enum","values":["open","fulfilled"]},"title":{"description":"A concise statement of the aspiration or desired outcome.","maxLength":100,"minLength":1,"required":true,"type":"string"}},"key":"wish","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"policies":{"create":{"all":[{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},{"left":{"$ref":"input.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}]},"delete":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}},"read":{"left":{"$ref":"actor.personId"},"op":"neq","right":{"value":null}},"update":{"left":{"$ref":"record.ownerPersonId"},"op":"eq","right":{"$ref":"actor.personId"}}},"query":{"filterable":["status","ownerPersonId","desiredDate"],"searchable":["title","description"],"sortable":["desiredDate","title"]},"route":"wishes"}',
  '56c2bba314e2cb1a887f50dd5bdceee8b4160681304a238142e50828cbb07984',
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

CREATE TABLE mdl_wish_simple_lifecycle (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  "description" TEXT,
  "desiredDate" TEXT,
  "fulfilledAt" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('open','fulfilled')),
  "title" TEXT NOT NULL,
  UNIQUE(space_id,record_id)
);

INSERT INTO mdl_wish_simple_lifecycle(
  record_id,space_id,"description","desiredDate","fulfilledAt","status","title"
)
SELECT
  record_id,space_id,"description","desiredDate","fulfilledAt","status","title"
FROM mdl_wish;

DROP TABLE mdl_wish;
ALTER TABLE mdl_wish_simple_lifecycle RENAME TO mdl_wish;

CREATE INDEX idx_mdl_wish_desiredDate ON mdl_wish(space_id,"desiredDate",record_id);
CREATE INDEX idx_mdl_wish_status ON mdl_wish(space_id,"status",record_id);
CREATE INDEX idx_mdl_wish_title ON mdl_wish(space_id,"title",record_id);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;

UPDATE schema_metadata SET value='30' WHERE key='schema_version';
