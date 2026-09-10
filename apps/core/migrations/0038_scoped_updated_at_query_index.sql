-- #218: envelope updatedAt comparison queries are always scoped by Space + Model.
-- The historical idx_resource_records_model begins with model_key and therefore
-- cannot bound a normal Space-scoped updatedAt range before scanning records from
-- other Spaces. Keep it for its existing consumers and add the query-shape-aligned
-- index rather than rewriting historical index semantics in place.

CREATE INDEX idx_resource_records_space_model_updated
  ON resource_records(space_id, model_key, deleted_at, updated_at DESC, id DESC);

UPDATE schema_metadata SET value='38' WHERE key='schema_version';
