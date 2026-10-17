-- UNIQUE(model_key, field_key) already owns the lookup index. Remove the
-- duplicate ordinary index added with schema 65 to avoid unnecessary D1 write
-- amplification while preserving the same uniqueness and lookup semantics.
DROP INDEX IF EXISTS idx_external_field_bindings_key;

UPDATE schema_metadata SET value='66' WHERE key='schema_version';
