CREATE TABLE model_definitions (
  id TEXT PRIMARY KEY CHECK(id GLOB 'mdl_*'),
  model_key TEXT NOT NULL,
  route_segment TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  state TEXT NOT NULL CHECK(state IN ('published','superseded','retired')),
  definition_version INTEGER NOT NULL CHECK(definition_version = 1),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  schema_hash TEXT NOT NULL CHECK(length(schema_hash) = 64),
  compatibility TEXT NOT NULL CHECK(compatibility IN ('initial','compatible','breaking')),
  published_by_type TEXT NOT NULL CHECK(published_by_type IN ('user','service','device')),
  published_by_id TEXT NOT NULL,
  published_by_name_snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  superseded_at TEXT,
  retired_at TEXT,
  UNIQUE(model_key, version),
  UNIQUE(route_segment, version)
);

CREATE UNIQUE INDEX idx_model_definitions_active_key
  ON model_definitions(model_key)
  WHERE state='published';

CREATE UNIQUE INDEX idx_model_definitions_active_route
  ON model_definitions(route_segment)
  WHERE state='published';

CREATE INDEX idx_model_definitions_history
  ON model_definitions(model_key, version DESC);

CREATE TABLE model_definition_drafts (
  id TEXT PRIMARY KEY CHECK(id GLOB 'mdr_*'),
  model_key TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  definition_version INTEGER NOT NULL CHECK(definition_version = 1),
  validation_json TEXT CHECK(validation_json IS NULL OR json_valid(validation_json)),
  base_published_version INTEGER,
  created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user','service','device')),
  created_by_id TEXT NOT NULL,
  created_by_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_model_definition_drafts_key
  ON model_definition_drafts(model_key, updated_at DESC);

-- Task is the first bootstrap model used to prove that an ordinary domain can be
-- represented by registry metadata instead of a handwritten runtime. This is a
-- platform seed, not a permanent special-case Task implementation.
INSERT INTO model_definitions(
  id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
  published_by_type,published_by_id,published_by_name_snapshot
) VALUES(
  'mdl_bootstrap_task_v1',
  'task',
  'tasks',
  1,
  'published',
  1,
  '{"access":["read","write"],"actions":{"complete":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_COMPLETED","field":"status","message":"Task is already completed","op":"neq","value":"completed"}],"set":{"completedAt":{"$ref":"now"},"completedById":{"$ref":"actor.id"},"completedByType":{"$ref":"actor.type"},"status":"completed"}},"reopen":{"access":"write","guards":[{"errorCode":"TASK_ALREADY_PENDING","field":"status","message":"Task is already pending","op":"neq","value":"pending"}],"set":{"completedAt":null,"completedById":null,"completedByType":null,"status":"pending"}}},"definitionVersion":1,"display":{"plural":"Tasks","singular":"Task"},"fields":{"assigneePersonIds":{"type":"person_list"},"completedAt":{"nullable":true,"readOnly":true,"type":"datetime"},"completedById":{"maxLength":100,"nullable":true,"readOnly":true,"type":"string"},"completedByType":{"nullable":true,"readOnly":true,"type":"enum","values":["user","service","device"]},"description":{"maxLength":5000,"nullable":true,"type":"text"},"dueDate":{"nullable":true,"type":"date"},"name":{"maxLength":100,"minLength":1,"required":true,"type":"string"},"status":{"required":true,"type":"enum","values":["pending","completed","cancelled"]}},"key":"task","lifecycle":{"optimisticConcurrency":true,"softDelete":true},"query":{"filterable":["status","dueDate","assigneePersonIds"],"searchable":["name","description"],"sortable":["dueDate","name"]},"route":"tasks"}',
  '1fd6d6fdc7bb6039503bf012aad9eeaf417459196b680133c4d2bf96ef9fb173',
  'initial',
  'service',
  'svc_lifespace_bootstrap',
  'LifeSpace bootstrap'
);

UPDATE schema_metadata
SET value='10'
WHERE key='schema_version';
