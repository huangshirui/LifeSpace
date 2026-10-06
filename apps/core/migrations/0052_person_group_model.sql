-- PBD Person foundation: publish Person Group as an ordinary metadata-driven model.
-- Group membership is a person_list relation and does not imply Authority or a typed
-- interpersonal relationship.

CREATE TABLE "mdl_person_group" (
  record_id TEXT PRIMARY KEY REFERENCES resource_records(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  "name" TEXT NOT NULL,
  "description" TEXT,
  UNIQUE(space_id,record_id)
);

CREATE INDEX "idx_mdl_person_group_name"
  ON "mdl_person_group"(space_id,"name",record_id);

INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_catalog_person_group_20261006',
  'person_group',
  'person_group',
  1,
  'published',
  1,
  '{"access":["read","write"],"definitionVersion":1,"description":"A durable named grouping of Space People used to refer to a set of people together, such as family, classmates, teammates, colleagues, or another user-defined circle. Membership expresses grouping only and does not imply authority or a typed interpersonal relationship.","display":{"plural":"Person Groups","singular":"Person Group"},"fields":{"description":{"description":"Optional context describing what the group represents.","maxLength":2000,"nullable":true,"title":"Description","type":"text"},"memberPersonIds":{"description":"Space People included in this group.","title":"Members","type":"person_list"},"name":{"description":"Human-readable name of the group or circle.","maxLength":100,"minLength":1,"required":true,"title":"Name","type":"string"}},"key":"person_group","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["memberPersonIds"],"searchable":["name","description"],"sortable":["name"]},"referenceLabel":{"field":"name"}}',
  '3a8398b99763b56d047ccb1fa75bf98873206a15ebed257d26d81d80f0796b51',
  'initial',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace schema 52 migration'
);

UPDATE model_registry_state
SET revision=revision+1,mutation_token=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

DELETE FROM model_contract_state;
UPDATE schema_metadata SET value='52' WHERE key='schema_version';
