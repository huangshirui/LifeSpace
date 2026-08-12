-- Phase 3 typed-storage destructive cleanup.
--
-- This migration is intentionally applied only after a typed-storage Core Worker
-- has already converged in staging. Ordinary business values now live in
-- deterministic mdl_<model_key> tables and relations remain in
-- resource_relations; the Phase-3 proving JSON/index representation is retired.

DROP TABLE resource_index_values;

ALTER TABLE resource_records DROP COLUMN data_json;

UPDATE schema_metadata
SET value='23'
WHERE key='schema_version';
