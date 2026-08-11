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

UPDATE schema_metadata
SET value='10'
WHERE key='schema_version';
